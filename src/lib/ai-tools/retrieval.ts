// 只读取证：模型在作答前调的工具，前端执行后把结果原样喂回（agent 循环），不产生确认卡片。
// 出口统一过 truncate，再多就该用片段检索而不是把整篇塞进上下文。

import type { JSONContent } from "@tiptap/core";
import { appTree, appWorkspaceId } from "../app-context";
import { docSearchSnippets } from "../ai";
import { databaseApi } from "../database";
import { formatCellValue, parseFieldOptions } from "../database-values";
import { documentApi } from "../documents";
import { t } from "../i18n";
import { logger } from "../logger";
import { jsonToMarkdown } from "../markdown";
import { searchApi } from "../search";
import { flattenTree } from "../tree";
import { resolvePage } from "./resolve-page";
import type { CellValue } from "@/types/database";
import type { ViewNode } from "@/types/models";

/** 单次检索结果给模型的最大字符数：再多就该用片段检索而不是整篇塞进上下文 */
const RESULT_CHAR_LIMIT = 6000;
/** 表数据查询的最大行数 */
const MAX_QUERY_ROWS = 30;

function truncate(text: string, limit = RESULT_CHAR_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断 ${trimmed.length - limit} 字）`;
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
  const tree = appTree();
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
  const workspaceId = appWorkspaceId();
  const views = flattenTree(appTree()).filter((v) => !isRowDetail(v));
  const str = (k: string) => (typeof args[k] === "string" ? args[k] : "");
  switch (name) {
    case "search_workspace": {
      const query = str("query").trim();
      if (!query) return t("ai.toolNoQuery");
      if (!workspaceId) return t("ai.toolNoWorkspace");
      const hits = await searchApi.search(workspaceId, query, views);
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

/** 只读工具入口 */
export async function runRetrievalCall(name: string, args: Record<string, unknown>, limit: number): Promise<string> {
  try {
    return truncate(await runRetrievalTool(name, args, limit));
  } catch (e) {
    logger.error("ai-tools: retrieval failed", name, e);
    return t("ai.toolFailed", { message: e instanceof Error ? e.message : String(e) });
  }
}
