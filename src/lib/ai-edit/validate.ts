// 单个动作的校验与规整：模型给的一切都是 unknown，落成 AiCall 之前逐项收窄。
// 从 lib/ai-edit.ts 原样搬出（逐行零改动）。
import {
  AI_EDIT_OPS,
  RETRIEVAL_TOOLS,
  type AiCall,
  type AiEditAnchor,
  type AiEditOp,
  type RetrievalKind,
} from "./types";

function validateAnchor(value: unknown): AiEditAnchor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const anchor: AiEditAnchor = {};
  if (typeof o.heading === "string" && o.heading.trim()) anchor.heading = o.heading.trim();
  if (typeof o.text === "string" && o.text.trim()) anchor.text = o.text;
  return Object.keys(anchor).length > 0 ? anchor : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 模型给的 cells 参数：非对象（含数组以外的一切脏值）按未提供处理 */
function optionalCells(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 校验并规整单个动作；不合法返回 null */
export function validateCall(value: unknown): AiCall | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  // 旧平铺格式：{"op":...,"summary":...,"content":...} → apply_edit
  if (typeof o.op === "string" && !("tool" in o)) {
    const call = validateCall({ tool: "apply_edit", args: o });
    return call;
  }
  const tool = o.tool;
  const args = (typeof o.args === "object" && o.args !== null ? o.args : {}) as Record<string, unknown>;
  switch (tool) {
    case "apply_edit": {
      const op = args.op;
      if (typeof op !== "string" || !AI_EDIT_OPS.includes(op as AiEditOp)) return null;
      const content = optionalString(args.content);
      // 除纯改名类操作外，content 必填
      if (!content) return null;
      const anchor = validateAnchor(args.anchor);
      const viewId = optionalString(args.view_id);
      return {
        tool: "apply_edit",
        args: {
          op: op as AiEditOp,
          summary: typeof args.summary === "string" ? args.summary.trim() : "",
          content,
          ...(anchor ? { anchor } : {}),
          ...(viewId ? { view_id: viewId } : {}),
        },
      };
    }
    case "create_page": {
      const title = optionalString(args.title);
      if (!title) return null;
      const content = optionalString(args.content);
      const parent = optionalString(args.parent_page);
      return {
        tool: "create_page",
        args: { title, ...(content ? { content } : {}), ...(parent ? { parent_page: parent } : {}) },
      };
    }
    case "set_page_title": {
      const page = optionalString(args.page);
      const title = optionalString(args.title);
      if (!page || !title) return null;
      return { tool: "set_page_title", args: { page, title } };
    }
    case "add_database_row": {
      const database = optionalString(args.database);
      if (!database) return null;
      const cells = optionalCells(args.cells);
      return { tool: "add_database_row", args: { database, ...(cells ? { cells } : {}) } };
    }
    case "update_database_row": {
      const database = optionalString(args.database);
      // row 缺失一律拒绝：没有行引用就只能靠猜，猜错改的是用户的数据
      const row = optionalString(args.row);
      const cells = optionalCells(args.cells);
      if (!database || !row) return null;
      return { tool: "update_database_row", args: { database, row, ...(cells ? { cells } : {}) } };
    }
    case "delete_database_row": {
      const database = optionalString(args.database);
      const row = optionalString(args.row);
      if (!database || !row) return null;
      return { tool: "delete_database_row", args: { database, row } };
    }
    default:
      if (RETRIEVAL_TOOLS.includes(tool as RetrievalKind)) {
        return { tool: tool as RetrievalKind, args };
      }
      return null;
  }
}
