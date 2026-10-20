import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import type { DbLayout } from "@/types/models";
import { invoke } from "@/lib/invoke";
import { newId, viewApi } from "./db";
import { databaseApi } from "./database";
import { computeEvaluatedCells } from "./database-evaluated-cells";
import { buildSelectOptions, collectSelectNames, importCell, planImport, selectCellToText } from "./csv";
import { isOptionBearing, parseFieldOptions } from "./database-values";
import { isComputedKind } from "./field-kinds";
import { logger } from "./logger";

// 数据库表 ↔ Markdown 表格（整库导出的数据出口）。
//
// 落盘文本只有一条纪律：**不随机器语言变**。所以日期一律 ISO 原文，
// 而不走 field-kinds 的 formatDate(toLocaleDateString) —— 同一份库换台机器导出成中文日期，
// 就再也不能被 inferFieldType 认回 date。

/** 附件/关联等数组单元格的成员 → 文本（附件取文件名，其余取字符串值） */
function memberText(v: string | { name: string; path: string }): string {
  return typeof v === "string" ? v : v.name;
}

/** 单元格值 → 落盘文本（选择类翻译回选项名，与按名解析的导入闭环） */
export function cellToExportText(field: DatabaseField, value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const opts = parseFieldOptions(field.options);
  if (opts.kind === "select") return selectCellToText(value, opts.options);
  if (Array.isArray(value)) return value.map(memberText).join("; ");
  return String(value);
}

/** 表 → 文本矩阵（首行表头）：与 fieldsRowsToText 同语义，但日期不本地化、且带计算列的求值 */
export function tableToTextMatrix(
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  includeHidden = false,
): string[][] {
  // 公式/汇总/反向关系没有存储值，必须先在内存求一遍，否则这几列永远是空的
  let values = cells;
  if (fields.some((f) => isComputedKind(f.field_type))) {
    try {
      values = computeEvaluatedCells(rows, cells, fields, () => undefined).display;
    } catch (e) {
      // 求值失败（如公式引用已删字段）退回原始单元格：宁可少几列计算值，也不要整页导出失败
      logger.warn("db-transfer", "evaluated cells failed, fallback to raw cells", e);
    }
  }
  const columns = includeHidden
    ? [...fields].sort((a, b) => a.position - b.position)
    : fields.filter((f) => f.is_hidden === 0);
  return [
    columns.map((f) => f.name),
    ...rows.map((r) => {
      const rowCells = values[r.id] ?? {};
      return columns.map((f) => cellToExportText(f, rowCells[f.id] ?? null));
    }),
  ];
}

/** 文本矩阵 → Markdown 表格（`\|` 转义竖线、`\` 转义反斜杠、换行写成 `<br>`） */
export function toMarkdownTable(matrix: string[][]): string {
  if (matrix.length === 0) return "";
  const cols = Math.max(...matrix.map((r) => r.length));
  const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const line = (row: string[]): string =>
    `| ${Array.from({ length: cols }, (_, i) => esc(row[i] ?? "")).join(" | ")} |`;
  const sep = `|${Array.from({ length: cols }, () => " --- ").join("|")}|`;
  return [line(matrix[0]), sep, ...matrix.slice(1).map(line)].join("\n");
}

/** 一行 Markdown 表格 → 单元格数组（按未转义的 `|` 切分，再还原 `\|`/`\`/`<br>`） */
function splitMarkdownRow(raw: string): string[] {
  const trimmed = raw
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length) {
      cur += trimmed[++i];
      continue;
    }
    if (ch === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/<br>/g, "\n"));
}

const TABLE_SEP_RE = /^\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?\s*)?\|?$/;

/** Markdown 文本里的第一张表格 → 文本矩阵（含表头行）；没有表格返回 null */
export function parseMarkdownTable(md: string): string[][] | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i];
    if (!head.trim().startsWith("|") || !TABLE_SEP_RE.test(lines[i + 1].trim())) continue;
    const matrix = [splitMarkdownRow(head)];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      matrix.push(splitMarkdownRow(lines[j]));
    }
    return matrix;
  }
  return null;
}

/** 读一个数据库视图的全部行，渲染成 Markdown 表格文本 */
export async function databaseViewToMarkdown(viewId: string, includeHidden: boolean): Promise<string> {
  const [fields, rows, cells] = await Promise.all([
    databaseApi.listFields(viewId),
    databaseApi.listRows(viewId),
    databaseApi.loadCells(viewId),
  ]);
  if (fields.length === 0) return "";
  return toMarkdownTable(tableToTextMatrix(fields, rows, cells, includeHidden));
}

/** 收集文档 JSON 里引用的数据库视图 id（导出前一次性预取表格文本，转换函数保持同步） */
export function collectDatabaseViewIds(node: unknown, out = new Set<string>()): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectDatabaseViewIds(child, out);
    return [...out];
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (rec.type === "databaseView") {
      const viewId = (rec.attrs as Record<string, unknown> | undefined)?.viewId;
      if (typeof viewId === "string" && viewId) out.add(viewId);
    }
    collectDatabaseViewIds(rec.content, out);
  }
  return [...out];
}

/** 文本矩阵 → 新建数据库视图（走 csv_import 单命令落库）。返回新视图 id 与行数。
 *  layout 缺省 grid；frontmatter 写了 board/calendar 的导入不该一律退回表格视图。 */
export async function createDatabaseViewFromTable(
  workspaceId: string,
  parentId: string | null,
  name: string,
  matrix: string[][],
  layout: DbLayout = "grid",
): Promise<{ viewId: string; rowCount: number }> {
  const { headers, types } = planImport(matrix);
  const dataRows = matrix.slice(1);
  const used = new Set<string>();
  const selectIdMaps: Record<number, Map<string, string>> = {};
  const fields = headers.map((header, i) => {
    let fieldName = header;
    while (used.has(fieldName)) fieldName = `${fieldName} 2`;
    used.add(fieldName);
    const type = types[i];
    // 选项列（单选 / 多选 / 状态）建字段时先按整列值预建选项，文本才落得成 id
    if (isOptionBearing(type)) {
      const { options, idByName } = buildSelectOptions(
        collectSelectNames(
          type,
          dataRows.map((r) => r[i] ?? ""),
        ),
      );
      selectIdMaps[i] = idByName;
      return { id: newId(), name: fieldName, field_type: type, options: JSON.stringify({ kind: "select", options }) };
    }
    return { id: newId(), name: fieldName, field_type: type, options: null };
  });
  const rows = dataRows.map((line) => {
    const cells: { field_id: string; value: string }[] = [];
    for (let i = 0; i < fields.length; i++) {
      const raw = line[i] ?? "";
      if (raw.trim() === "") continue;
      const cell = importCell(fields[i].field_type, raw, selectIdMaps[i]);
      if (cell !== null) cells.push({ field_id: fields[i].id, value: JSON.stringify(cell) });
    }
    return { id: newId(), cells };
  });
  const view = await viewApi.create({ workspace_id: workspaceId, parent_id: parentId, name, layout });
  // 嵌套 payload 按 Rust 结构体声明的 snake_case 键传（同 GridView 的 CSV 导入契约）
  await invoke("csv_import", { viewId: view.id, fields, rows });
  return { viewId: view.id, rowCount: rows.length };
}
