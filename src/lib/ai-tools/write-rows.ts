// 表行写动作：加行 / 改若干格 / 删行（进回收站）。与页面类的共同点是每个动作成功时都带回一份 UndoPlan，
// 差别只在改已有行要「先读旧值、撤销时按清单盖回去」。

import { appInvalidateRelations } from "../app-context";
import { databaseApi } from "../database";
import { notifyDatabaseChanged } from "../database-changed";
import { cellWriteTypeSafe } from "../database-values";
import { t } from "../i18n";
import { coerceCell } from "./cell-coerce";
import { resolvePage } from "./resolve-page";
import type { WriteOutcome } from "./undo-plan";
import type { CellValue, DatabaseField } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import type { ViewNode } from "@/types/models";

export async function addDatabaseRow(args: {
  database: string;
  cells?: Record<string, unknown>;
}): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const fields = await databaseApi.listFields(node.id);
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
  const row = await databaseApi.createRow(node.id);
  const written: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
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
  const tail =
    (skipped.length > 0 ? t("ai.actionCellsSkipped", { fields: skipped.join(", ") }) : "") +
    (rejected.length > 0 ? t("ai.actionCellsRejected", { fields: rejected.join(", ") }) : "");
  // 绕开了 database store 的写入口：手动失效 relation 缓存，否则其它库的关联/汇总列看不到这条新行
  appInvalidateRelations([node.id]);
  notifyDatabaseChanged([node.id]);
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
  const tail =
    (skipped.length > 0 ? t("ai.actionCellsSkipped", { fields: skipped.join(", ") }) : "") +
    (rejected.length > 0 ? t("ai.actionCellsRejected", { fields: rejected.join(", ") }) : "");
  if (written.length === 0) {
    // 一格都没写成不能报「成功」：卡片会显示已更新，而用户的表什么都没变
    return { ok: false, detail: `${t("ai.actionNothingWritten")}${tail}` };
  }
  appInvalidateRelations([node.id]);
  notifyDatabaseChanged([node.id]);
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
  appInvalidateRelations([node.id]);
  notifyDatabaseChanged([node.id]);
  return {
    ok: true,
    id: found.row_id,
    detail: t("ai.actionRowDeleted", { database: node.name }),
    undo: { kind: "restore_row", database: node.id, row_id: found.row_id },
  };
}
