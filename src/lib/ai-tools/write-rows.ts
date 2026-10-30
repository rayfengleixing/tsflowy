// 表行写动作：加行 / 改若干格 / 删行（进回收站）。与页面类的共同点是每个动作成功时都带回一份 UndoPlan，
// 差别只在改已有行要「先读旧值、撤销时按清单盖回去」。
// 失败侧与页面类也不同：写一半崩了（补建选项或落格的 IPC 失败）就地回滚，不留孤儿——
// 失败卡片上没有撤销入口，回滚的活儿不能交给用户。

import { appInvalidateRelations } from "../app-context";
import { databaseApi } from "../backend/database";
import { notifyDatabaseChanged } from "../database/database-changed";
import { cellWriteTypeSafe } from "../database/database-values";
import { t } from "../i18n";
import { coerceCell } from "./cell-coerce";
import { resolvePage } from "./resolve-page";
import type { WriteOutcome } from "./undo-plan";
import type { CellValue, DatabaseField } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import type { ViewNode } from "@/types/models";

/** 落库之后统一做这两件（成功、回滚都走它）：失效关联缓存 + 让正显示这张表的页面重取 */
function afterTableWrite(databaseId: string): void {
  appInvalidateRelations([databaseId]);
  notifyDatabaseChanged([databaseId]);
}

/** 撤掉本次动作凭空建的行。撤不动时返回一句要拼进提示的话，而不是默默当成已回滚 */
async function rollbackCreatedRow(rowId: string): Promise<string> {
  try {
    await databaseApi.purgeRow(rowId);
    return "";
  } catch {
    return t("ai.actionRowRollbackFailed");
  }
}

export async function addDatabaseRow(args: {
  database: string;
  cells?: Record<string, unknown>;
}): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const fields = await databaseApi.listFields(node.id);
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
  const row = await databaseApi.createRow(node.id);
  const wanted = Object.keys(args.cells ?? {}).length;
  const written: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
  try {
    for (const [key, value] of Object.entries(args.cells ?? {})) {
      const field = pickField(fields, byName, key);
      if (!field) {
        skipped.push(key);
        continue;
      }
      const cell = await coerceCell(field, value);
      // 与 store 的写入口共用同一道闸门：这里直接调 databaseApi，不经 stores/database，
      // 缺了它就等于给模型开了一条能往数字列塞文本、往日期列塞散文的旁路
      if (isReadonlyType(field.field_type) || !cellWriteTypeSafe(field, cell)) {
        rejected.push(field.name);
        continue;
      }
      await databaseApi.setCell(row.id, field.id, cell);
      written.push(field.name);
    }
  } catch (e) {
    // 写到一半失败：这行是本次动作凭空造的，就地删掉；留在表里就是一行没人要的半截数据。
    // coerceCell 顺带补建的选项不回滚——那是加法、且与 store 写入口一样留着不碍事。
    const note = await rollbackCreatedRow(row.id);
    afterTableWrite(node.id);
    return { ok: false, detail: `${e instanceof Error ? e.message : String(e)}${note}` };
  }
  const tail =
    (skipped.length > 0 ? t("ai.actionCellsSkipped", { fields: skipped.join(", ") }) : "") +
    (rejected.length > 0 ? t("ai.actionCellsRejected", { fields: rejected.join(", ") }) : "");
  if (wanted > 0 && written.length === 0) {
    // 与 update_database_row 同一条守卫：给了 cells 却一格都没写成，不能报「已新增一行」，
    // 更不能在用户的表里留一行空行
    const note = await rollbackCreatedRow(row.id);
    afterTableWrite(node.id);
    return { ok: false, detail: `${t("ai.actionNothingWritten")}${tail}${note}` };
  }
  // 绕开了 database store 的写入口：手动失效 relation 缓存，否则其它库的关联/汇总列看不到这条新行
  afterTableWrite(node.id);
  return {
    ok: true,
    id: row.id,
    detail: `${t("ai.actionRowAdded", {
      database: node.name,
      fields: written.join(", ") || t("ai.actionRowEmpty"),
    })}${tail}`,
    // 撤销 AI 加的行 = 彻底删掉它（这行是本次动作凭空造的，进回收站只是留一堆空行垃圾）
    undo: { kind: "purge_row", database: node.id, row_id: row.id },
  };
}

/**
 * 行引用 → 行 id：先按 id 精确命中，再把引用当作「某一格的文本值」找唯一匹配。
 * 模型手里只有 query_database 输出的行 id，但它常常顺手写回标题之类，
 * 因此两条都支持；匹配到多行时必须报错，选错行改的是用户的数据。
 */
async function resolveRowId(node: ViewNode, ref: string): Promise<{ row_id: string } | { error: string }> {
  const rows = await databaseApi.listRows(node.id);
  const byId = rows.find((r) => r.id === ref);
  if (byId) return { row_id: byId.id };
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return { error: t("ai.toolRowNotFound", { ref }) };
  const cells = (await databaseApi.loadCells(node.id)) as Record<string, Record<string, CellValue> | undefined>;
  const matches = rows.filter((r) =>
    Object.values(cells[r.id] ?? {}).some((v) => typeof v === "string" && v.trim().toLowerCase() === wanted),
  );
  if (matches.length === 1) return { row_id: matches[0].id };
  return {
    error:
      matches.length > 1
        ? t("ai.toolRowAmbiguous", { ref, count: String(matches.length) })
        : t("ai.toolRowNotFound", { ref }),
  };
}

/** 写一格并记下它改前的值（撤销时按这份清单原样盖回去） */
async function writeCellWithUndo(
  rowId: string,
  current: Record<string, CellValue>,
  field: DatabaseField,
  raw: unknown,
): Promise<{ ok: true; reset: { row_id: string; field_id: string; value: CellValue } } | { ok: false }> {
  const cell = await coerceCell(field, raw);
  // 与 add_database_row 共用同一道闸门：模型给数字列塞文本、给日期列塞散文时拒写
  if (isReadonlyType(field.field_type) || !cellWriteTypeSafe(field, cell)) return { ok: false };
  const reset = { row_id: rowId, field_id: field.id, value: current[field.id] ?? null };
  await databaseApi.setCell(rowId, field.id, cell);
  return { ok: true, reset };
}

/** 找字段：模型给的是字段名（大小写/空白宽容），也接受直接给字段 id */
function pickField(
  fields: DatabaseField[],
  byName: Map<string, DatabaseField>,
  key: string,
): DatabaseField | undefined {
  return byName.get(key.trim().toLowerCase()) ?? fields.find((f) => f.id === key);
}

/** 改已有行的若干单元格：与加行的差别只在「先读旧值，撤销时写回旧值」 */
export async function updateDatabaseRow(args: {
  database: string;
  row: string;
  cells?: Record<string, unknown>;
}): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const found = await resolveRowId(node, args.row);
  if ("error" in found) return { ok: false, detail: found.error };
  const fields = await databaseApi.listFields(node.id);
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
  const current =
    ((await databaseApi.loadCells(node.id)) as Record<string, Record<string, CellValue> | undefined>)[found.row_id] ??
    {};
  const written: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
  const resets: { row_id: string; field_id: string; value: CellValue }[] = [];
  try {
    for (const [key, value] of Object.entries(args.cells ?? {})) {
      const field = pickField(fields, byName, key);
      if (!field) {
        skipped.push(key);
        continue;
      }
      const done = await writeCellWithUndo(found.row_id, current, field, value);
      if (!done.ok) {
        rejected.push(field.name);
        continue;
      }
      resets.push(done.reset);
      written.push(field.name);
    }
  } catch (e) {
    // 写一半失败：已经落进去的格子按刚记下的旧值盖回去，用户在表里看到的还是改前那副样子。
    // 一格都没写成就别折腾（也没要通知的），盖回本身又崩了才在提示里点名
    let note = "";
    if (resets.length > 0) {
      try {
        await databaseApi.setCellsMany(resets.map((r) => ({ rowId: r.row_id, fieldId: r.field_id, value: r.value })));
      } catch {
        note = t("ai.actionCellsRollbackFailed");
      }
      afterTableWrite(node.id);
    }
    return { ok: false, detail: `${e instanceof Error ? e.message : String(e)}${note}` };
  }
  const tail =
    (skipped.length > 0 ? t("ai.actionCellsSkipped", { fields: skipped.join(", ") }) : "") +
    (rejected.length > 0 ? t("ai.actionCellsRejected", { fields: rejected.join(", ") }) : "");
  if (written.length === 0) {
    // 一格都没写成不能报「成功」：卡片会显示已更新，而用户的表什么都没变
    return { ok: false, detail: `${t("ai.actionNothingWritten")}${tail}` };
  }
  afterTableWrite(node.id);
  return {
    ok: true,
    id: found.row_id,
    detail: `${t("ai.actionRowUpdated", { database: node.name, fields: written.join(", ") })}${tail}`,
    undo: { kind: "reset_cells", database: node.id, items: resets },
  };
}

/** 删一行：走回收站（与用户手动删行同一条路径），撤销即 restore 回原位置 */
export async function deleteDatabaseRow(args: { database: string; row: string }): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const found = await resolveRowId(node, args.row);
  if ("error" in found) return { ok: false, detail: found.error };
  await databaseApi.deleteRow(found.row_id);
  afterTableWrite(node.id);
  return {
    ok: true,
    id: found.row_id,
    detail: t("ai.actionRowDeleted", { database: node.name }),
    undo: { kind: "restore_row", database: node.id, row_id: found.row_id },
  };
}
