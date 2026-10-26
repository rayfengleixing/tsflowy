// 写动作的逆操作链：UndoPlan 是纯数据（不是闭包），能随会话 JSON 落库、重启后仍可撤销；
// sanitizeUndoPlan 是外部数据入口（字段逐个验类型），runUndoPlan 把计划执行掉并做界面刷新。

import { appInvalidateRelations, appReload, appRenameView } from "../app-context";
import { viewApi } from "../db";
import { databaseApi } from "../database";
import { notifyDatabaseChanged } from "../database-changed";
import { t } from "../i18n";
import { logger } from "../logger";
import type { CellValue } from "@/types/database";

/**
 * 写动作的逆操作计划：纯数据（不是闭包），所以能随会话 JSON 落库，
 * 重启后仍然可撤销 —— 这与文档编辑的 revert（只在当前编辑器实例的 undo 栈里有效）是两套机制。
 * 每条都只描述「把这份数据改回去」，不依赖撤销时刻的界面状态。
 */
export type UndoPlan =
  | { kind: "remove_view"; view_id: string }
  | { kind: "rename_view"; view_id: string; name: string }
  | { kind: "purge_row"; database: string; row_id: string }
  | { kind: "restore_row"; database: string; row_id: string }
  | { kind: "reset_cells"; database: string; items: { row_id: string; field_id: string; value: CellValue }[] };

/** 写动作的执行结果：detail 是给模型/界面看的说明，undo 是「撤销这次改动」的逆操作 */
export interface WriteOutcome {
  ok: boolean;
  detail: string;
  /** 新建页面/行成功时的 id，供界面上提供「打开」入口 */
  id?: string;
  undo?: UndoPlan;
}

/**
 * 从会话 JSON 里恢复逆操作计划：形状不认识的（含旧会话根本没写这个字段）一律按不可撤销处理。
 * 这里是外部数据入口，字段必须逐个验类型——计划里的 id 会直接喂给写库的 API。
 */
export function sanitizeUndoPlan(raw: unknown): UndoPlan | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && v ? v : "");
  const database = id(o.database);
  const rowId = id(o.row_id);
  switch (o.kind) {
    case "remove_view": {
      const viewId = id(o.view_id);
      return viewId ? { kind: "remove_view", view_id: viewId } : undefined;
    }
    case "rename_view": {
      const viewId = id(o.view_id);
      const name = id(o.name);
      return viewId && name ? { kind: "rename_view", view_id: viewId, name } : undefined;
    }
    case "purge_row":
    case "restore_row":
      return database && rowId ? { kind: o.kind, database, row_id: rowId } : undefined;
    case "reset_cells": {
      if (!database || !Array.isArray(o.items)) return undefined;
      const items = o.items.flatMap((x) => {
        if (typeof x !== "object" || x === null) return [];
        const i = x as Record<string, unknown>;
        const oneRow = id(i.row_id);
        const fieldId = id(i.field_id);
        // value 允许 null（撤销就是把这格清空），其余按 CellValue 的几种形态收
        const v = i.value;
        const valueOk =
          v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" || Array.isArray(v);
        return oneRow && fieldId && valueOk ? [{ row_id: oneRow, field_id: fieldId, value: v as CellValue }] : [];
      });
      // 一条都不剩就别留个空壳计划：卡片上会出现按了没反应的撤销按钮
      return items.length > 0 ? { kind: "reset_cells", database, items } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 执行逆操作计划（用户点「撤销」）。与 runWriteAction 一样把界面刷新做掉：
 * 树的变动走 workspace.reload，表的变动走 notifyDatabaseChanged + relation 失效。
 */
export async function runUndoPlan(plan: UndoPlan): Promise<WriteOutcome> {
  try {
    switch (plan.kind) {
      case "remove_view": {
        await viewApi.softDelete(plan.view_id);
        await appReload();
        return { ok: true, detail: t("ai.undoPageRemoved") };
      }
      case "rename_view": {
        await appRenameView(plan.view_id, plan.name);
        return { ok: true, detail: t("ai.undoTitleRestored", { name: plan.name }) };
      }
      case "purge_row": {
        await databaseApi.purgeRow(plan.row_id);
        appInvalidateRelations([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoRowRemoved") };
      }
      case "restore_row": {
        await databaseApi.restoreRow(plan.row_id);
        appInvalidateRelations([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoRowRestored") };
      }
      case "reset_cells": {
        await databaseApi.setCellsMany(
          plan.items.map((i) => ({ rowId: i.row_id, fieldId: i.field_id, value: i.value })),
        );
        appInvalidateRelations([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoCellsRestored", { n: String(plan.items.length) }) };
      }
    }
  } catch (e) {
    logger.error("ai-tools: undo plan failed", plan.kind, e);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
