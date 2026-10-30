import type { AttachmentRef, CellValue, DatabaseField, DatabaseRow, FieldType, SelectOption } from "@/types/database";
import { fieldKind, isOptionBearing } from "../database/field-kinds";
import { newSelectOption, parseFieldOptions } from "../database/database-values";
import { t } from "../i18n";

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
    // 只有字段起始处的引号才开启引用态；字段中间的裸引号按字面字符处理（Excel 行为），
    // 否则 `abc"def,x` 会进入引用态把逗号吞进同一字段
    if (ch === '"' && field === "") {
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

/** 从样例值推断字段类型（数字/日期/布尔/URL/邮箱/电话 → 专用类型，否则文本） */
export function inferFieldType(samples: string[]): FieldType {
  const nonEmpty = samples.filter((v) => String(v).trim() !== "");
  if (nonEmpty.length === 0) return "text";
  const looksLike = (re: RegExp) => nonEmpty.every((v) => re.test(String(v).trim()));
  // 前导零（"007"、电话号码）不是数字语义：回落 text，否则 Number() 一过 0 就丢了
  if (looksLike(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/)) return "number";
  if (looksLike(/^(true|false|是|否|✓|✗)$/i)) return "checkbox";
  if (looksLike(/^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/)) return "date";
  if (looksLike(/^https?:\/\/\S+$/i)) return "url";
  if (looksLike(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/)) return "email";
  // 电话：整体像号码（可 + 开头、含分隔符），且至少 6 位数字；
  // 纯数字串不认电话（已被 number 分支收走，带前导零的纯数字如 "021" 太短也进不来）
  if (
    looksLike(/^[+\d(][\d\-.()\s]{5,18}$/) &&
    nonEmpty.every((v) => (v.match(/\d/g) ?? []).length >= 6) &&
    nonEmpty.every((v) => /^[+(]/.test(v) || /[-.()\s]/.test(v))
  )
    return "phone";
  return "text";
}

/** 按字段类型把 CSV 字符串值转成 CellValue（与说明书 7.2 编码一致）。
 *  逐类型的解读在 field-kinds 注册表的 paste 里；选择类这里只交出名→值的直译，
 *  要「按名解析成 id 并补建缺失选项」走 pasteCell。 */
export function csvValueToCell(type: FieldType, raw: string): CellValue {
  const outcome = fieldKind(type).paste(raw);
  if (outcome.kind === "value") return outcome.value;
  if (outcome.kind === "option_names") {
    return type === "multi_select" ? outcome.names : (outcome.names[0] ?? null);
  }
  return null; // skip：一段文本给不出该类型的合法值
}

/** 一格文本要写进单元格的结果；pasteCell 返回 null 表示这格不该写 */
export interface PastedCell {
  value: CellValue;
  /** 选择类有名字补建选项失败：写出去的值不完整，由调用方决定是否提示 */
  degraded: boolean;
}

export interface PasteDeps {
  /** 取字段此刻的最新定义：上一格补建的选项要参与下一格的解析，避免同名重复建 */
  latestField(fieldId: string): DatabaseField | undefined;
  /** 补建缺失选项，返回新选项 id；失败返回 null */
  createOption(fieldId: string, name: string): Promise<string | null>;
}

/**
 * 粘贴/CSV 落地一格文本 → 待写值（TSV 粘贴与「追加到当前表」共用，原先两条路径各写一遍分派）。
 * 返回 null = 这格跳过：只读/计算字段、关联与附件（文本给不出行 id 和文件）、选择类字段没配选项。
 */
export async function pasteCell(field: DatabaseField, raw: string, deps: PasteDeps): Promise<PastedCell | null> {
  const target = deps.latestField(field.id) ?? field;
  const outcome = fieldKind(target.field_type).paste(raw);
  if (outcome.kind === "skip") return null;
  if (outcome.kind === "value") return { value: outcome.value, degraded: false };

  const options = parseFieldOptions(target.options);
  if (options.kind !== "select") return null;
  const idByName = new Map(options.options.map((o) => [o.name, o.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of outcome.names) {
    const id = idByName.get(name);
    if (id !== undefined) {
      if (!ids.includes(id)) ids.push(id);
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }
  // 先落已认识的、再逐个建缺的：保持改造前「已知 id 在前、新建 id 在后」的顺序
  let degraded = false;
  for (const name of missing) {
    const created = await deps.createOption(target.id, name);
    if (created === null) degraded = true;
    else ids.push(created);
  }
  return { value: target.field_type === "multi_select" ? ids : (ids[0] ?? null), degraded };
}

/** 单元格值 → CSV 字符串（导出用） */
export function cellToCsv(_type: FieldType, value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    // 附件单元格是 [{name,path}]：导出只写文件名（多选/关联等则是字符串数组）
    return value
      .map((v) => (typeof v === "object" && "name" in v ? String((v as { name: unknown }).name) : String(v)))
      .join("; ");
  }
  return String(value);
}

/** 选择类单元格 → 选项名串（单元格存的是选项 id，导出必须翻译回名字才能与按名解析的粘贴闭环） */
export function selectCellToText(value: CellValue, options: SelectOption[]): string {
  if (value === null) return "";
  const nameOf = new Map(options.map((o) => [o.id, o.name]));
  const one = (v: string | AttachmentRef): string => (typeof v === "string" ? (nameOf.get(v) ?? v) : v.name);
  if (Array.isArray(value)) return value.map(one).join("; ");
  return typeof value === "string" ? one(value) : String(value);
}

/** 选择类列：从整列原始文本收集去重后的选项名（单选取整串、多选按 ; | 拆分），供预置 options */
export function collectSelectNames(type: FieldType, rawColumn: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawColumn) {
    const { names } = splitSelectNames(type, raw);
    for (const n of names) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** 拆分选择类单元格文本为选项名数组（单选整串、多选 ; | 分列；trim 去空）。
 *  分隔规则取自 field-kinds 的 paste，与粘贴/导入路径同一份知识。 */
function splitSelectNames(type: FieldType, raw: string): { names: string[] } {
  const outcome = fieldKind(type).paste(raw);
  return { names: outcome.kind === "option_names" ? outcome.names : [] };
}

/** 为选择类列生成 options（按名去重，复用 newSelectOption 的随机配色），并返回「名 → id」表 */
export function buildSelectOptions(names: string[]): { options: SelectOption[]; idByName: Map<string, string> } {
  const options: SelectOption[] = [];
  const idByName = new Map<string, string>();
  for (const name of names) {
    if (idByName.has(name)) continue;
    const opt = newSelectOption(name);
    options.push(opt);
    idByName.set(name, opt.id);
  }
  return { options, idByName };
}

/** 选择类单元格文本 → 存库值（单选 = 选项 id 字符串；多选 = id 数组）。空返回 null。
 *  调用方须先用 buildSelectOptions 保证所有名字都已建选项（idByName 覆盖列内全部名）。 */
export function selectCellToIds(type: FieldType, raw: string, idByName: Map<string, string>): CellValue {
  const { names } = splitSelectNames(type, raw);
  if (names.length === 0) return null;
  const ids: string[] = [];
  for (const n of names) {
    const id = idByName.get(n);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  if (type === "multi_select") return ids.length > 0 ? ids : null;
  return ids[0] ?? null;
}

/** 「新建表导入」一格文本 → 存库值（与粘贴是两条链路，别混用）：
 *  - 选项列：字段此刻还没落库，整列选项名已在建字段时预建成 id（buildSelectOptions），
 *    所以按名直译，不走 pasteCell 的「缺选项就补建」异步副作用路径；
 *  - 其余类型：走注册表 paste，与粘贴/追加 CSV 同一份「文本怎么读」的知识；
 *  - 附件列：文本给不出文件，由调用方先按「文件名 → assets 复制」处理，不会走到这里。
 *  返回 null = 这格不写。 */
export function importCell(type: FieldType, raw: string, optionIdsByName?: Map<string, string>): CellValue {
  if (isOptionBearing(type)) return selectCellToIds(type, raw, optionIdsByName ?? new Map<string, string>());
  return csvValueToCell(type, raw);
}

/** CSV 附件列原始值 → 候选文件名（`[;|]` 分隔、trim、去空、按小写去重）。
 *  再按「小写文件名 → 绝对路径」表逐个精确匹配（大小写不敏感）。
 *  纯函数、不做任何 I/O：命中的 sourcePath 交给调用方 save_asset 复制进 assets/。
 *  同名候选只算一次（保留首次出现的原始写法，供 isImageFile 等按扩展名判断）。 */
export function resolveAttachmentNames(
  raw: string,
  filesByLowerName: Record<string, string>,
): { matched: { name: string; sourcePath: string }[]; missing: string[] } {
  const seen = new Set<string>();
  const matched: { name: string; sourcePath: string }[] = [];
  const missing: string[] = [];
  for (const name of raw
    .split(/[;|]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const sourcePath = filesByLowerName[key] as string | undefined;
    if (sourcePath !== undefined) matched.push({ name, sourcePath });
    else missing.push(name);
  }
  return { matched, missing };
}

/** 表 → 文本矩阵（首行表头，之后每行一个数据库行）。CSV 与 Markdown 导出共用这一份取值规则：
 *  选择类单元格存的是选项 id，必须翻译回选项名，才能与「按名解析」的粘贴/导入闭环。 */
export function fieldsRowsToText(
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
  includeHidden = false,
): string[][] {
  const columns = includeHidden ? fields : fields.filter((f) => f.is_hidden === 0);
  return [
    columns.map((f) => f.name),
    ...rows.map((r) =>
      columns.map((f) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
        const value = cells[r.id]?.[f.id] ?? null;
        const opts = parseFieldOptions(f.options);
        if (opts.kind === "select" && isOptionBearing(f.field_type)) {
          return selectCellToText(value, opts.options);
        }
        return cellToCsv(f.field_type, value);
      }),
    ),
  ];
}

/** 导出当前视图：首行表头，之后每行一个数据库行 */
export function buildCsvExport(
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
): string {
  return toCsv(fieldsRowsToText(fields, rows, cells));
}

/** 导入计划：列头 → 字段（类型推断用前 20 个样例）；空列头生成 "字段 N"（导入为新表，编号从 1 起） */
export function planImport(parsed: string[][]): { headers: string[]; types: FieldType[] } {
  if (parsed.length === 0) return { headers: [], types: [] };
  const header = parsed[0].map((h, i) => h.trim() || t("csv.defaultFieldName", { n: i + 1 }));
  const sampleRows = parsed.slice(1, 21);
  const types = header.map((_, col) => {
    const samples = sampleRows.map((r) => r[col] ?? "");
    return inferFieldType(samples);
  });
  return { headers: header, types };
}
