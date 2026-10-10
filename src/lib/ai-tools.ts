// AI 助手的工具执行层：把模型下发的动作落到本地知识库。
//
// 分两类：
// - 只读取证（search_workspace / list_pages / get_page_content / list_database_fields / query_database）：
//   模型在作答前调用，前端执行后把结果原样喂回模型（agent 循环），不产生确认卡片。
// - 写动作（create_page / set_page_title / add_database_row）：改动用户数据，默认走确认卡片，
//   用户点「应用」或设置关闭确认时才真正执行（文档编辑 apply_edit 走 ai-editor/ai-locate，不在这里）。
//
// 之所以在前端执行：页面树、文档、数据库的权威状态与写入串行化都在前端 store/lib 里，
// Rust 侧再实现一套等于把同一份业务规则抄两遍。

import type { JSONContent } from "@tiptap/core";
import { docSearchSnippets, type AiToolSpec } from "./ai";
import { markdownToNodes } from "./ai-locate";
import { viewApi } from "./db";
import { databaseApi } from "./database";
import { formatCellValue, newSelectOption, parseFieldOptions } from "./database-values";
import { documentApi } from "./documents";
import { t } from "./i18n";
import { logger } from "./logger";
import { jsonToMarkdown } from "./markdown";
import { searchApi } from "./search";
import { flattenTree } from "./tree";
import { useWorkspaceStore } from "@/stores/workspace";
import type { CellValue, DatabaseField } from "@/types/database";
import type { ViewNode } from "@/types/models";

/** 单次检索结果给模型的最大字符数：再多就该用片段检索而不是整篇塞进上下文 */
const RESULT_CHAR_LIMIT = 6000;
/** 表数据查询的最大行数 */
const MAX_QUERY_ROWS = 30;

function truncate(text: string, limit = RESULT_CHAR_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断 ${trimmed.length - limit} 字）`;
}

/** 页面引用（id 或标题）→ 树节点；标题匹配先精确后模糊，歧义时返回 null */
export function resolvePage(ref: string): ViewNode | null {
  const list = flattenTree(useWorkspaceStore.getState().tree);
  if (!ref) return null;
  const byId = list.find((v) => v.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const exact = list.filter((v) => v.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const fuzzy = list.filter((v) => v.name.trim().toLowerCase().includes(wanted));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

function isRowDetail(node: ViewNode): boolean {
  try {
    return !!(JSON.parse(node.extra) as { row_detail?: unknown }).row_detail;
  } catch {
    return false;
  }
}

/** 页面清单文本（缩进体现层级），供 list_pages 与建页时的父页面选择 */
function renderTree(limit = 200): string {
  const tree = useWorkspaceStore.getState().tree;
  const lines: string[] = [];
  const walk = (nodes: ViewNode[], depth: number) => {
    for (const n of nodes) {
      if (lines.length >= limit) return;
      if (isRowDetail(n)) continue;
      lines.push(`${"  ".repeat(depth)}- ${n.name || t("common.untitled")} [id=${n.id}] (${n.layout})`);
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  if (lines.length >= limit) lines.push(`…（共 ${limit} 条，仅列出前 ${limit} 个页面）`);
  return lines.join("\n");
}

async function readPageMarkdown(viewId: string, limit: number, query = ""): Promise<string> {
  const raw = await documentApi.get(viewId);
  if (!raw) return "";
  let doc: JSONContent;
  try {
    const parsed = JSON.parse(raw) as JSONContent | JSONContent[];
    doc = Array.isArray(parsed) ? { type: "doc", content: parsed } : parsed;
  } catch (e) {
    logger.warn("ai-tools: document json invalid", viewId, e);
    return "";
  }
  const md = jsonToMarkdown(doc).trim();
  if (!md) return "";
  if (md.length <= limit) return md;
  if (query) {
    const snippets = await docSearchSnippets(viewId, query, 8).catch(() => [] as string[]);
    if (snippets.length > 0) return snippets.join("\n…\n").slice(0, limit);
  }
  return `${md.slice(0, limit)}\n…（已截断 ${md.length - limit} 字）`;
}

/** 只读取证工具的执行：返回值即喂回模型的文本 */
async function runRetrievalTool(name: string, args: Record<string, unknown>, limit: number): Promise<string> {
  const ws = useWorkspaceStore.getState();
  const views = flattenTree(ws.tree).filter((v) => !isRowDetail(v));
  const str = (k: string) => (typeof args[k] === "string" ? args[k] : "");
  switch (name) {
    case "search_workspace": {
      const query = str("query").trim();
      if (!query) return t("ai.toolNoQuery");
      if (!ws.currentWorkspaceId) return t("ai.toolNoWorkspace");
      const hits = await searchApi.search(ws.currentWorkspaceId, query, views);
      if (hits.length === 0) return t("ai.toolNoHit");
      const lines = hits.slice(0, 12).map((h) => {
        const snip = h.snippet
          .replace(/<\/?em>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return `- ${h.title || t("common.untitled")} [id=${h.view_id}] (${h.layout})${snip ? `：${snip.slice(0, 200)}` : ""}`;
      });
      return `${t("ai.toolHits", { count: hits.length })}\n${lines.join("\n")}`;
    }
    case "list_pages":
      return renderTree();
    case "get_page_content": {
      const ref = str("page");
      const node = resolvePage(ref);
      if (!node) return t("ai.toolPageNotFound", { ref });
      const md = await readPageMarkdown(node.id, limit, str("query"));
      return md || t("ai.toolPageEmpty", { name: node.name });
    }
    case "list_database_fields":
    case "query_database": {
      const ref = str("database");
      const node = resolvePage(ref);
      if (!node) return t("ai.toolPageNotFound", { ref });
      const fields = (await databaseApi.listFields(node.id)).filter((f) => !f.is_hidden);
      const fieldLines = fields
        .map((f) => {
          const opts = parseFieldOptions(f.options);
          const choices = opts.kind === "select" ? `（选项：${opts.options.map((o) => o.name).join(" / ")}）` : "";
          return `- ${f.name} [${f.field_type}]${choices}`;
        })
        .join("\n");
      if (name === "list_database_fields") {
        return fieldLines || t("ai.toolNoFields");
      }
      const rows = await databaseApi.listRows(node.id);
      const cells = await databaseApi.loadCells(node.id);
      // 新建的行可能一条 cell 都没有，索引结果按可能缺失处理
      const cellMap = cells as Record<string, Record<string, CellValue> | undefined>;
      const take = Math.min(
        MAX_QUERY_ROWS,
        typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : MAX_QUERY_ROWS,
      );
      const shown = rows.slice(0, take);
      const header = fields.map((f) => f.name).join(" | ");
      const body = shown
        .map((r) =>
          fields
            .map((f) => formatCellValue(f.field_type, cellMap[r.id]?.[f.id] ?? null, parseFieldOptions(f.options)))
            .join(" | "),
        )
        .join("\n");
      return `${t("ai.toolRows", { shown: shown.length, total: rows.length })}\n${header}\n${body}`;
    }
    default:
      return t("ai.toolUnknown", { name });
  }
}

/** 写动作的执行结果：detail 是给模型/界面看的说明 */
export interface WriteOutcome {
  ok: boolean;
  detail: string;
  /** 新建页面/行成功时的 id，供界面上提供「打开」入口 */
  id?: string;
}

function newDocumentJson(title: string, contentMarkdown: string): JSONContent {
  // 与页面模板同构：首行 H1 标题 + 分割线 + 正文，结构锁定依赖这个形状
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
      { type: "horizontalRule" },
      ...markdownToNodes(contentMarkdown),
    ],
  };
}

async function createPage(args: { title: string; content?: string; parent_page?: string }): Promise<WriteOutcome> {
  const ws = useWorkspaceStore.getState();
  if (!ws.currentWorkspaceId) return { ok: false, detail: t("ai.toolNoWorkspace") };
  let parentId: string | null = null;
  let parentName = "";
  if (args.parent_page) {
    const parent = resolvePage(args.parent_page);
    if (!parent) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.parent_page }) };
    parentId = parent.id;
    parentName = parent.name;
  } else if (ws.currentViewId) {
    // 未指定父页面：挂在当前页之下（就地建子页），没有当前页则建在根
    parentId = ws.currentViewId;
    parentName = resolvePage(ws.currentViewId)?.name ?? "";
  }
  const view = await viewApi.create({
    workspace_id: ws.currentWorkspaceId,
    parent_id: parentId,
    name: args.title,
    layout: "document",
  });
  try {
    await documentApi.save(view.id, JSON.stringify(newDocumentJson(args.title, args.content ?? "")));
  } catch (e) {
    logger.error("ai-tools: save new page failed", view.id, e);
    return { ok: false, detail: t("ai.actionCreateFailed", { title: args.title }) };
  }
  await ws.reload();
  return {
    ok: true,
    detail: t("ai.actionCreated", {
      title: args.title,
      parent: parentId ? t("ai.actionCreatedChild", { name: parentName }) : t("ai.actionCreatedRoot"),
    }),
    id: view.id,
  };
}

async function setPageTitle(args: { page: string; title: string }): Promise<WriteOutcome> {
  const node = resolvePage(args.page);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.page }) };
  await useWorkspaceStore.getState().renameView(node.id, args.title);
  return { ok: true, detail: t("ai.actionRenamed", { from: node.name, to: args.title }) };
}

/** 模型给的任意 JSON 值 → 文本：对象走 JSON 形式，避免 String() 得到 [object Object] */
function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** 模型给的单元格值 → 该字段类型能存的值（选项按名称匹配，缺失则补建选项） */
async function coerceCell(field: DatabaseField, raw: unknown): Promise<CellValue> {
  const type = field.field_type;
  if (raw === null || raw === undefined || raw === "") return null;
  const text = cellText(raw);
  const opts = parseFieldOptions(field.options);
  const optionId = (name: string): string => {
    if (opts.kind !== "select") return name;
    const hit = opts.options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
    return hit ? hit.id : name;
  };
  switch (type) {
    case "number":
    case "progress":
    case "rating":
    case "currency": {
      const n = typeof raw === "number" ? raw : Number(text.replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return raw === true || ["true", "1", "yes", "y", "是", "已", "完成"].includes(text.trim().toLowerCase());
    case "multi_select": {
      const items = Array.isArray(raw) ? raw : text.split(/[,，、]/);
      return items.map((x) => optionId(cellText(x))).filter(Boolean);
    }
    case "single_select": {
      const name = text.trim();
      if (!name) return null;
      if (opts.kind === "select" && !opts.options.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
        // 新选项：直接补进字段配置，否则模型每次写新值都会落成一个裸 id
        const option = newSelectOption(name);
        await databaseApi.updateFieldOptions(field.id, { kind: "select", options: [...opts.options, option] });
        return option.id;
      }
      return optionId(name);
    }
    case "url":
    case "phone":
    case "email":
    case "text":
    case "date":
      return text;
    default:
      return null;
  }
}

async function addDatabaseRow(args: { database: string; cells?: Record<string, unknown> }): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const fields = await databaseApi.listFields(node.id);
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
  const row = await databaseApi.createRow(node.id);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(args.cells ?? {})) {
    const field = byName.get(key.trim().toLowerCase()) ?? fields.find((f) => f.id === key);
    if (!field) {
      skipped.push(key);
      continue;
    }
    const cell = await coerceCell(field, value);
    await databaseApi.setCell(row.id, field.id, cell);
    written.push(field.name);
  }
  const tail = skipped.length > 0 ? t("ai.actionCellsSkipped", { fields: skipped.join(", ") }) : "";
  return {
    ok: true,
    id: row.id,
    detail: `${t("ai.actionRowAdded", {
      database: node.name,
      fields: written.join(", ") || t("ai.actionRowEmpty"),
    })}${tail}`,
  };
}

export type WriteCall =
  | { tool: "create_page"; args: { title: string; content?: string; parent_page?: string } }
  | { tool: "set_page_title"; args: { page: string; title: string } }
  | { tool: "add_database_row"; args: { database: string; cells?: Record<string, unknown> } };

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
    }
  } catch (e) {
    logger.error("ai-tools: write action failed", call.tool, e);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 只读工具入口 */
export async function runRetrievalCall(name: string, args: Record<string, unknown>, limit: number): Promise<string> {
  try {
    return truncate(await runRetrievalTool(name, args, limit));
  } catch (e) {
    logger.error("ai-tools: retrieval failed", name, e);
    return t("ai.toolFailed", { message: e instanceof Error ? e.message : String(e) });
  }
}

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
