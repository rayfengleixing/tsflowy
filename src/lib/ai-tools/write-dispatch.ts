// 写动作分发：把模型下发的 WriteCall 派到具体的页面/表行动作上，兜住动作层的异常。
// 文档编辑 apply_edit 由 stores/ai 走编辑器/JSON 路径，不从这里过。

import { logger } from "../logger";
import { addDatabaseRow, deleteDatabaseRow, updateDatabaseRow } from "./write-rows";
import { createPage, setPageTitle } from "./write-page";
import type { WriteOutcome } from "./undo-plan";

export type WriteCall =
  | { tool: "create_page"; args: { title: string; content?: string; parent_page?: string } }
  | { tool: "set_page_title"; args: { page: string; title: string } }
  | { tool: "add_database_row"; args: { database: string; cells?: Record<string, unknown> } }
  | { tool: "update_database_row"; args: { database: string; row: string; cells?: Record<string, unknown> } }
  | { tool: "delete_database_row"; args: { database: string; row: string } };

/** 写动作分发（文档编辑 apply_edit 由 stores/ai.ts 走编辑器/JSON 路径，不从这里过） */
export async function runWriteAction(call: WriteCall): Promise<WriteOutcome & { id?: string }> {
  try {
    switch (call.tool) {
      case "create_page":
        return await createPage(call.args);
      case "set_page_title":
        return await setPageTitle(call.args);
      case "add_database_row":
        return await addDatabaseRow(call.args);
      case "update_database_row":
        return await updateDatabaseRow(call.args);
      case "delete_database_row":
        return await deleteDatabaseRow(call.args);
    }
  } catch (e) {
    logger.error("ai-tools: write action failed", call.tool, e);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
