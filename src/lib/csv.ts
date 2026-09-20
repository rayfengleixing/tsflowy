import type { CellValue, DatabaseField, DatabaseRow, FieldType, SelectOption } from "@/types/database";
import { parseFieldOptions } from "./database-values";

// CSV 导入导出（项目说明书 10-M4）。解析/生成/类型推断为纯函数，便于单测。

/** 解析 CSV 文本 → 二维字符串数组（支持引号包裹、"" 转义、字段内换行） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  // 去掉完全空白的尾行
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** 解析剪贴板 TSV（Excel/WPS/网页表格复制格式）：按 \t 分列、\r?\n 分行；
 *  含制表/换行的单元格被双引号包裹（内部 "" 转义），与 Excel 剪贴板行为一致 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        field += ch;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  row.push(field);
  rows.push(row);
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** 二维数组 → CSV 文本 */
export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

/** 从样例值推断字段类型（数字/日期/布尔 → 专用类型，否则文本） */
export function inferFieldType(samples: string[]): FieldType {
  const nonEmpty = samples.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonEmpty.length === 0) return "text";
  const looksLike = (re: RegExp) => nonEmpty.every((v) => re.test(String(v).trim()));
  if (looksLike(/^[+-]?\d+(\.\d+)?$/)) return "number";
  if (looksLike(/^(true|false|是|否|✓|✗)$/i)) return "checkbox";
  if (looksLike(/^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/)) return "date";
  return "text";
}

/** 按字段类型把 CSV 字符串值转成 CellValue（与说明书 7.2 编码一致） */
export function csvValueToCell(type: FieldType, raw: string): CellValue {
  const v = raw.trim();
  if (v === "") return null;
  switch (type) {
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return /^(true|是|✓|1)$/i.test(v);
    case "date": {
      // 统一存 ISO 日期字符串（不带时间则纯日期）
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toISOString();
    }
    case "multi_select":
      return v
        .split(/[;|]/)
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return v;
  }
}

/** 单元格值 → CSV 字符串（导出用） */
export function cellToCsv(_type: FieldType, value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

/** 选择类单元格 → 选项名串（单元格存的是选项 id，导出必须翻译回名字才能与按名解析的粘贴闭环） */
function selectCellToText(value: CellValue, options: SelectOption[]): string {
  if (value === null) return "";
  const nameOf = new Map(options.map((o) => [o.id, o.name]));
  const one = (v: CellValue) => (typeof v === "string" ? (nameOf.get(v) ?? v) : String(v));
  if (Array.isArray(value)) return value.map(one).join("; ");
  return one(value);
}

/** 文本 → 选择类字段的选项 id：单选取整串，多选按 ; | 分列。
 *  未匹配的名字进 missing，由调用方决定新建（TSV 粘贴路径会补建选项）。 */
export function resolveSelectRefs(
  type: FieldType,
  raw: string,
  options: SelectOption[],
): { ids: string[]; missing: string[] } {
  const names =
    type === "multi_select"
      ? raw
          .split(/[;|]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : raw.trim() === ""
        ? []
        : [raw.trim()];
  const byName = new Map(options.map((o) => [o.name, o.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const id = byName.get(name);
    if (id !== undefined) {
      if (!ids.includes(id)) ids.push(id);
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }
  return { ids, missing };
}

/** 导出当前视图：首行表头，之后每行一个数据库行 */
export function buildCsvExport(
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
): string {
  const visible = fields.filter((f) => f.is_hidden === 0);
  const header = visible.map((f) => f.name);
  const body = rows.map((r) =>
    visible.map((f) => {
      const value = cells[r.id]?.[f.id] ?? null;
      const opts = parseFieldOptions(f.options);
      if (opts.kind === "select" && (f.field_type === "single_select" || f.field_type === "multi_select")) {
        return selectCellToText(value, opts.options);
      }
      return cellToCsv(f.field_type, value);
    }),
  );
  return toCsv([header, ...body]);
}

/** 导入计划：列头 → 字段（类型推断用前 20 个样例）；空列头生成 "字段 N"（导入为新表，编号从 1 起） */
export function planImport(parsed: string[][]): { headers: string[]; types: FieldType[] } {
  if (parsed.length === 0) return { headers: [], types: [] };
  const header = parsed[0].map((h, i) => h.trim() || `字段 ${i + 1}`);
  const sampleRows = parsed.slice(1, 21);
  const types = header.map((_, col) => {
    const samples = sampleRows.map((r) => r[col] ?? "");
    return inferFieldType(samples);
  });
  return { headers: header, types };
}
