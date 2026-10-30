// 动作协议的形状：模型回传的一个动作长什么样、哪些算写动作、哪些只读，以及两类指令代码块的标记语言名。
// 从 lib/ai-edit.ts 原样搬出（逐行零改动）；tool_calls 与文本块两条路都收敛成这里的 AiCall。
/**
 * 文档编辑指令的作用范围。
 * 刻意不含「整篇重写」：文档首行 H1 是标题、第二行分割线由 DocumentStructureLock
 * 保护，整篇替换的事务必然被拦截（见 features/editor/extensions/document-structure-lock.ts）。
 * 后三个是定位类 op：用 anchor 指明位置（heading=定位标题，text=定位原文），
 * 可以配合 view_id 作用于其它已入库的页面。
 */
export type AiEditOp =
  | "replace_selection"
  | "insert_at_cursor"
  | "append_to_document"
  | "insert_under_heading"
  | "replace_under_heading"
  | "replace_text";

export const AI_EDIT_OPS: readonly AiEditOp[] = [
  "replace_selection",
  "insert_at_cursor",
  "append_to_document",
  "insert_under_heading",
  "replace_under_heading",
  "replace_text",
];

/** 定位类 op 必须给出锚点：heading 优先（标题文本），text 用于 replace_text（被替换的原文） */
export interface AiEditAnchor {
  heading?: string;
  text?: string;
}

/** 模型下发的一个动作（文档编辑 / 建页 / 改名 / 表行增删改 / 只读检索） */
export type AiCall =
  | {
      tool: "apply_edit";
      args: { op: AiEditOp; summary?: string; content: string; anchor?: AiEditAnchor; view_id?: string };
    }
  | { tool: "create_page"; args: { title: string; content?: string; parent_page?: string } }
  | { tool: "set_page_title"; args: { page: string; title: string } }
  | { tool: "add_database_row"; args: { database: string; cells?: Record<string, unknown> } }
  | { tool: "update_database_row"; args: { database: string; row: string; cells?: Record<string, unknown> } }
  | { tool: "delete_database_row"; args: { database: string; row: string } }
  | { tool: RetrievalKind; args: Record<string, unknown> };

/** 只读检索类工具：前端就地执行、把结果喂回模型，不产生确认卡片 */
export type RetrievalKind =
  "search_workspace" | "list_pages" | "get_page_content" | "list_database_fields" | "query_database";

export const RETRIEVAL_TOOLS: readonly RetrievalKind[] = [
  "search_workspace",
  "list_pages",
  "get_page_content",
  "list_database_fields",
  "query_database",
];

/** 只读检索动作本体 */
export type RetrievalCall = Extract<AiCall, { tool: RetrievalKind }>;

export const WRITE_TOOLS = [
  "apply_edit",
  "create_page",
  "set_page_title",
  "add_database_row",
  "update_database_row",
  "delete_database_row",
] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];

/** 会改动用户数据的动作（其余为只读检索） */
export type AiWriteCall = Extract<AiCall, { tool: WriteTool }>;

/** 动作指令代码块的标记语言名（沿用历史名，旧会话与旧配置无需迁移） */
export const EDIT_BLOCK_TAG = "tsflowy-edit";

/** 只读检索请求块的标记：模型输出它表示「先帮我查，我拿到结果再作答」 */
export const CALL_BLOCK_TAG = "tsflowy-call";

/**
 * 指令代码块的围栏。与上面两个标记并排放：协议里「围栏 + 标记」是一个整体开栏，
 * 分头写就会变成改围栏要三处找（extract 的私有常量、protocol 的两处转义反引号、用例里的字面量）。
 */
export const FENCE = "```";
