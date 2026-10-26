// 下发给服务商的工具定义表（名称 + 说明 + JSON Schema 参数）：文本协议模式下也下发同一份，
// 保证两种协议的能力一致。

import type { AiToolSpec } from "../ai";

/** 下发给服务商的工具定义表（名称 + 说明 + JSON Schema 参数） */
const TOOL_DEFS: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "apply_edit",
    description: "把改动写进文档：当前页或 view_id 指定的页面。只是回答问题时不要调用。",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "replace_selection",
            "insert_at_cursor",
            "append_to_document",
            "insert_under_heading",
            "replace_under_heading",
            "replace_text",
          ],
        },
        summary: { type: "string" },
        content: { type: "string" },
        anchor: { type: "object", properties: { heading: { type: "string" }, text: { type: "string" } } },
        view_id: { type: "string" },
      },
      required: ["op", "content"],
    },
  },
  {
    name: "create_page",
    description: "新建一个文档页面（可带正文），parent_page 指定父页面。",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" }, parent_page: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "set_page_title",
    description: "修改某个页面的标题。",
    parameters: {
      type: "object",
      properties: { page: { type: "string", description: "页面 id 或标题" }, title: { type: "string" } },
      required: ["page", "title"],
    },
  },
  {
    name: "add_database_row",
    description: "往某个表格里新增一行，cells 为字段名到值的映射。",
    parameters: {
      type: "object",
      properties: {
        database: { type: "string", description: "表页面 id 或标题" },
        cells: { type: "object", description: "字段名 → 值" },
      },
      required: ["database"],
    },
  },
  {
    name: "update_database_row",
    description: "修改某个表格里已存在的行，只改 cells 里给出的字段。先用 query_database 拿 row。",
    parameters: {
      type: "object",
      properties: {
        database: { type: "string", description: "表页面 id 或标题" },
        row: { type: "string", description: "行 id（query_database 每行第一列）；也接受全库唯一的单元格文本" },
        cells: { type: "object", description: "字段名 → 新值" },
      },
      required: ["database", "row"],
    },
  },
  {
    name: "delete_database_row",
    description: "删除某个表格里的一行（进回收站，可撤销）。删前先确认行找对了。",
    parameters: {
      type: "object",
      properties: {
        database: { type: "string", description: "表页面 id 或标题" },
        row: { type: "string", description: "行 id，或全库唯一的单元格文本" },
      },
      required: ["database", "row"],
    },
  },
  {
    name: "search_workspace",
    description: "全库关键词检索，返回命中的页面与片段。回答问题前需要事实依据时使用。",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_pages",
    description: "列出当前工作区的页面树（含 id）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_page_content",
    description: "读取某个页面的正文（Markdown）。",
    parameters: {
      type: "object",
      properties: {
        page: { type: "string", description: "页面 id 或标题" },
        query: { type: "string", description: "长文档时按此词取相关片段" },
      },
      required: ["page"],
    },
  },
  {
    name: "list_database_fields",
    description: "列出某个表格的字段名、类型与选项。",
    parameters: { type: "object", properties: { database: { type: "string" } }, required: ["database"] },
  },
  {
    name: "query_database",
    description: "查询某个表格的行数据。",
    parameters: {
      type: "object",
      properties: { database: { type: "string" }, limit: { type: "number" } },
      required: ["database"],
    },
  },
];

/** OpenAI 协议的工具定义：文本协议模式下也下发同一份，保证两种模式能力一致 */
export function aiToolSpecs(): AiToolSpec[] {
  return TOOL_DEFS.map((d) => ({ type: "function" as const, function: d }));
}
