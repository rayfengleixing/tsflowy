// AI 助手的工具执行层：把模型下发的动作落到本地知识库。
//
// 分两类：
// - 只读取证（search_workspace / list_pages / get_page_content / list_database_fields / query_database）：
//   模型在作答前调用，前端执行后把结果原样喂回模型（agent 循环），不产生确认卡片。
// - 写动作（create_page / set_page_title / add_database_row / update_database_row / delete_database_row）：
//   改动用户数据，默认走确认卡片，用户点「应用」或设置关闭确认时才真正执行
//   （文档编辑 apply_edit 走 ai-editor/ai-locate，不在这里）。
//   每个写动作成功时返回一份 UndoPlan（纯数据逆操作），落进会话 JSON 后重启也能撤销。
//
// 之所以在前端执行：页面树、文档、数据库的权威状态与写入串行化都在前端 store/lib 里，
// Rust 侧再实现一套等于把同一份业务规则抄两遍。

import type { JSONContent } from "@tiptap/core";
import { docSearchSnippets, type AiToolSpec } from "./ai";
import { markdownToNodes } from "./ai-locate";
import { viewApi } from "./db";
import { databaseApi } from "./database";
import { notifyDatabaseChanged } from "./database-changed";
import { cellWriteTypeSafe, formatCellValue, newSelectOption, parseFieldOptions } from "./database-values";
import { documentApi } from "./documents";
import { fieldKind } from "./field-kinds";
import { t } from "./i18n";
import { logger } from "./logger";
import { jsonToMarkdown } from "./markdown";
import { searchApi } from "./search";
import { flattenTree } from "./tree";
import { useRelationStore } from "@/stores/relation";
import { useWorkspaceStore } from "@/stores/workspace";
import type { CellValue, DatabaseField } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { parseViewAliases, type ViewNode } from "@/types/models";

/** 单次检索结果给模型的最大字符数：再多就该用片段检索而不是整篇塞进上下文 */
const RESULT_CHAR_LIMIT = 6000;
/** 表数据查询的最大行数 */
const MAX_QUERY_ROWS = 30;

function truncate(text: string, limit = RESULT_CHAR_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断 ${trimmed.length - limit} 字）`;
}

/**
 * 页面引用（id、标题或别名）→ 树节点；匹配不到或歧义时返回 null，绝不猜。
 * 标题优先于别名：`计划书` 既是某页的名字又是另一页的别名时，叫这个名字的那页才是用户要的。
 */
export function resolvePage(ref: string): ViewNode | null {
  const list = flattenTree(useWorkspaceStore.getState().tree);
  if (!ref) return null;
  const byId = list.find((v) => v.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const eq = (name: string) => name.trim().toLowerCase() === wanted;
  const byTitle = list.filter((v) => eq(v.name));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) return null; // 两页同名，本来就无从判断
  const byAlias = list.filter((v) => parseViewAliases(v.aliases).some(eq));
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) return null;
  const namesOf = (v: ViewNode) => [v.name, ...parseViewAliases(v.aliases)].map((n) => n.trim().toLowerCase());
  const fuzzy = list.filter((v) => namesOf(v).some((n) => n.includes(wanted)));
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
      // 行 id 打在每行开头：模型要改/删某一行时得能说清是哪一行，否则 update/delete 只能靠文本猜
      const header = `${t("ai.toolRowIdColumn")} | ${fields.map((f) => f.name).join(" | ")}`;
      const body = shown
        .map(
          (r) =>
            `${r.id} | ${fields
              .map((f) => formatCellValue(f.field_type, cellMap[r.id]?.[f.id] ?? null, parseFieldOptions(f.options)))
              .join(" | ")}`,
        )
        .join("\n");
      return `${t("ai.toolRows", { shown: shown.length, total: rows.length })}\n${header}\n${body}`;
    }
    default:
      return t("ai.toolUnknown", { name });
  }
}

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
    // 撤销 AI 建的页 = 进回收站（软删），与用户手动删页同一条语义：还能再找回，不是二次销毁
    undo: { kind: "remove_view", view_id: view.id },
  };
}

async function setPageTitle(args: { page: string; title: string }): Promise<WriteOutcome> {
  const node = resolvePage(args.page);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.page }) };
  await useWorkspaceStore.getState().renameView(node.id, args.title);
  return {
    ok: true,
    detail: t("ai.actionRenamed", { from: node.name, to: args.title }),
    undo: { kind: "rename_view", view_id: node.id, name: node.name },
  };
}

/** 模型给的任意 JSON 值 → 文本：对象走 JSON 形式，避免 String() 得到 [object Object] */
function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** 模型给的单元格值 → 该字段类型能存的值（选项按名称匹配，缺失则补建选项） */
export async function coerceCell(field: DatabaseField, raw: unknown): Promise<CellValue> {
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
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const digits = text.replace(/[^\d.-]/g, "");
      // 一个数字都没有时不能走 Number("")——那是 0，会把「待定」这类文本静默写成零
      const n = digits === "" || digits === "-" ? NaN : Number(digits);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return raw === true || ["true", "1", "yes", "y", "是", "已", "完成"].includes(text.trim().toLowerCase());
    case "multi_select": {
      const names = (Array.isArray(raw) ? raw : text.split(/[,，、]/)).map((x) => cellText(x).trim()).filter(Boolean);
      if (opts.kind !== "select") return names;
      // 与单选一致：先补建缺失选项。落裸名称当 id 会让展示、筛选、对端关联全都对不上
      const known = new Set(opts.options.map((o) => o.name.toLowerCase()));
      const missing = names.filter((n) => !known.has(n.toLowerCase()));
      const created = [...new Set(missing)].map((name) => newSelectOption(name));
      if (created.length > 0) {
        await databaseApi.updateFieldOptions(field.id, { kind: "select", options: [...opts.options, ...created] });
      }
      return names
        .map((name) => {
          const hit = opts.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
          if (hit) return hit.id;
          return created.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? "";
        })
        .filter(Boolean);
    }
    case "single_select":
    case "status": {
      const name = text.trim();
      if (!name) return null;
      if (opts.kind === "select" && !opts.options.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
        // 新选项：直接补进字段配置，否则模型每次写新值都会落成一个裸 id
        const option = newSelectOption(name, type === "status" ? "todo" : undefined);
        await databaseApi.updateFieldOptions(field.id, { kind: "select", options: [...opts.options, option] });
        return option.id;
      }
      return optionId(name);
    }
    case "date": {
      // 走日期类型自己的粘贴归一：模型给「2024/1/5」「Jan 5, 2024」都收成 ISO，
      // 直接落原文会让日期列的排序、筛选、日历分组全部失效（validate 只认字符串，拦不住语义脏值）
      const outcome = fieldKind("date").paste(text);
      return outcome.kind === "value" ? outcome.value : text;
    }
    case "url":
    case "phone":
    case "email":
    case "text":
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
  useRelationStore.getState().invalidate([node.id]);
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
async function updateDatabaseRow(args: {
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
  useRelationStore.getState().invalidate([node.id]);
  notifyDatabaseChanged([node.id]);
  return {
    ok: true,
    id: found.row_id,
    detail: `${t("ai.actionRowUpdated", { database: node.name, fields: written.join(", ") })}${tail}`,
    undo: { kind: "reset_cells", database: node.id, items: resets },
  };
}

/** 删一行：走回收站（与用户手动删行同一条路径），撤销即 restore 回原位置 */
async function deleteDatabaseRow(args: { database: string; row: string }): Promise<WriteOutcome> {
  const node = resolvePage(args.database);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.database }) };
  const found = await resolveRowId(node, args.row);
  if ("error" in found) return { ok: false, detail: found.error };
  await databaseApi.deleteRow(found.row_id);
  useRelationStore.getState().invalidate([node.id]);
  notifyDatabaseChanged([node.id]);
  return {
    ok: true,
    id: found.row_id,
    detail: t("ai.actionRowDeleted", { database: node.name }),
    undo: { kind: "restore_row", database: node.id, row_id: found.row_id },
  };
}

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

/**
 * 执行逆操作计划（用户点「撤销」）。与 runWriteAction 一样把界面刷新做掉：
 * 树的变动走 workspace.reload，表的变动走 notifyDatabaseChanged + relation 失效。
 */
export async function runUndoPlan(plan: UndoPlan): Promise<WriteOutcome> {
  try {
    switch (plan.kind) {
      case "remove_view": {
        await viewApi.softDelete(plan.view_id);
        await useWorkspaceStore.getState().reload();
        return { ok: true, detail: t("ai.undoPageRemoved") };
      }
      case "rename_view": {
        await useWorkspaceStore.getState().renameView(plan.view_id, plan.name);
        return { ok: true, detail: t("ai.undoTitleRestored", { name: plan.name }) };
      }
      case "purge_row": {
        await databaseApi.purgeRow(plan.row_id);
        useRelationStore.getState().invalidate([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoRowRemoved") };
      }
      case "restore_row": {
        await databaseApi.restoreRow(plan.row_id);
        useRelationStore.getState().invalidate([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoRowRestored") };
      }
      case "reset_cells": {
        await databaseApi.setCellsMany(
          plan.items.map((i) => ({ rowId: i.row_id, fieldId: i.field_id, value: i.value })),
        );
        useRelationStore.getState().invalidate([plan.database]);
        notifyDatabaseChanged([plan.database]);
        return { ok: true, detail: t("ai.undoCellsRestored", { n: String(plan.items.length) }) };
      }
    }
  } catch (e) {
    logger.error("ai-tools: undo plan failed", plan.kind, e);
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
