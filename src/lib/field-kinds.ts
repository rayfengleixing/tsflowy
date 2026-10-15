// 字段类型注册表（Strategy / Type Map）：一种字段类型的「值语义 + 能力」在这里集中声明一份。
// 新增类型 = 在 FIELD_KINDS 补一条 spec（Record<FieldType, …> 漏写会编译报错），
// 不必再去 formatCellValue / validateCellValue / opsForType / canGroupBy 的 switch 里各补一个 case。
// 依赖方向：本模块只依赖 @/types/database，是被 database-values / database-query 依赖的叶子。
// React 那一臂（编辑器分派）在 features/database/editors.tsx 的 CELL_EDITORS 映射，纯逻辑不掺组件。
// 只读判定仍以 @/types/database 的 isReadonlyType 为准（无存储值的计算字段 + 触发器维护的时间戳）。
import type { FilterOp } from "./database-query";
import { isReadonlyType } from "@/types/database";
import type { AttachmentRef, CellValue, FieldOptions, FieldType } from "@/types/database";

/** 值的比较语义域：筛选/排序按域选路（日期按天聚拢、列表看包含、计算字段无存储值） */
export type ValueDomain = "text" | "number" | "boolean" | "date" | "list" | "computed";

/** 一段剪贴板/CSV 文本在该类型上的解读结果 */
export type PasteOutcome =
  /** 文本给不出合法值：关联要行 id、附件要文件、计算字段无存储值 */
  | { kind: "skip" }
  | { kind: "value"; value: CellValue }
  /** 选择类：只拆出选项名，id 由调用方解析（缺的选项要补建，是异步副作用） */
  | { kind: "option_names"; names: string[] };

export interface FieldKindSpec {
  /** 单元格 JSON 还原后的值形态校验（脏数据判非法，空值由调用方先放行） */
  validate(value: CellValue): boolean;
  /** 新建行的初始值 */
  emptyValue(): CellValue;
  /** 静态文本展示：导出、看板卡片、内嵌预览等没有专用渲染组件时走这里 */
  format(value: CellValue, options: FieldOptions): string;
  /** 粘贴 / CSV 落地：文本 → 单元格值（说明书 7.2 编码） */
  paste(raw: string): PasteOutcome;
  /** 筛选器可选操作符 */
  filterOps: FilterOp[];
  domain: ValueDomain;
  /** 能否进「分组」下拉（只读判定见 canGroupByKind，不在此重复） */
  groupable: boolean;
  /** 是否携带选项列表（options.kind === "select"）：导入整列要先按值预建选项，
   *  字段设置要显示选项编辑器；其余类型这一位恒 false */
  optionBearing: boolean;
}

const DEFAULT_NUMBER_OPTS: Extract<FieldOptions, { kind: "number" }> = {
  kind: "number",
  format: "decimal",
  precision: 2,
  currency: "CNY",
};

const isStr = (v: CellValue): v is string => typeof v === "string";
const isNum = (v: CellValue): v is number => typeof v === "number" && Number.isFinite(v);
const isIdList = (v: CellValue): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function numberOpts(options: FieldOptions): Extract<FieldOptions, { kind: "number" }> {
  return options.kind === "number" ? options : DEFAULT_NUMBER_OPTS;
}

/** 数字按格式展示（说明书 5.1：整数/小数/百分比/货币） */
export function formatNumber(value: number, opts: Extract<FieldOptions, { kind: "number" }>): string {
  const { format, precision, currency } = opts;
  switch (format) {
    case "integer":
      return String(Math.round(value));
    case "percent":
      return value.toFixed(Math.max(0, precision)) + "%";
    case "currency":
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: Math.max(0, precision),
      }).format(value);
    case "decimal":
    default:
      return value.toFixed(Math.max(0, precision));
  }
}

/** 从单元格值里挑出合法的附件引用（容忍脏数据：非对象项直接丢弃） */
export function attachmentRefs(value: CellValue): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is AttachmentRef => typeof v === "object" && typeof v.name === "string" && typeof v.path === "string",
  );
}

/** rating 字段的满星数（options 缺省或非法时回落 5） */
export function ratingMax(options?: FieldOptions): number {
  if (options?.kind === "rating" && Number.isFinite(options.max) && options.max >= 1) {
    return Math.min(10, Math.round(options.max));
  }
  return 5;
}

/** 时间字段存 UTC ISO；date 按 options 决定带不带时间，系统字段恒只到日 */
function formatDate(value: CellValue, includeTime: boolean): string {
  if (!isStr(value)) return "";
  const d = new Date(value.endsWith("Z") ? value : value + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return includeTime ? d.toLocaleString() : d.toLocaleDateString();
}

const VALUE_NULL: PasteOutcome = { kind: "value", value: null };
const SKIP: PasteOutcome = { kind: "skip" };

/** 空串写成 null（= 清空单元格），其余按 trim 后的文本原样存 */
function textOutcome(raw: string): PasteOutcome {
  const v = raw.trim();
  return v === "" ? VALUE_NULL : { kind: "value", value: v };
}

/** 数字族：非法数字按空处理，而不是保留原文（number 的 validate 只收数值） */
function numberOutcome(raw: string, parse: (s: string) => number = Number): PasteOutcome {
  const v = raw.trim();
  if (v === "") return VALUE_NULL;
  const n = parse(v);
  return Number.isFinite(n) ? { kind: "value", value: n } : VALUE_NULL;
}

/** 日期：已是 YYYY-MM-DD 直接存，其它能解析的归一成 ISO，解析不了按原文存 */
function dateOutcome(raw: string): PasteOutcome {
  const v = raw.trim();
  if (v === "") return VALUE_NULL;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return { kind: "value", value: v };
  const d = new Date(v);
  return { kind: "value", value: Number.isNaN(d.getTime()) ? v : d.toISOString() };
}

/** 选择类：只交出选项名；名 → id 要补建缺失选项（写库副作用），由 pasteCell 负责 */
function optionNamesOutcome(names: string[]): PasteOutcome {
  return { kind: "option_names", names };
}

const TEXT_LIKE: FieldKindSpec = {
  validate: (v) => isStr(v),
  emptyValue: () => null,
  format: (v) => (Array.isArray(v) ? (v as string[]).join(",") : String(v)),
  paste: textOutcome,
  filterOps: ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"],
  domain: "text",
  groupable: true,
  optionBearing: false,
};

const NUMBER_LIKE: FieldKindSpec = {
  validate: (v) => isNum(v),
  emptyValue: () => null,
  format: (v, options) => (isNum(v) ? formatNumber(v, numberOpts(options)) : ""),
  paste: (raw) => numberOutcome(raw),
  filterOps: ["is_empty", "is_not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"],
  domain: "number",
  groupable: true,
  optionBearing: false,
};

const DATE_LIKE: FieldKindSpec = {
  validate: (v) => isStr(v),
  emptyValue: () => null,
  format: (v, options) => formatDate(v, options.kind === "date" && options.include_time),
  paste: dateOutcome,
  filterOps: ["is_empty", "is_not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"],
  domain: "date",
  groupable: true,
  optionBearing: false,
};

// 关联/反向关系存的是对端行 id，真正展示要解析成行标题 —— 由 RelationChips 负责，
// 这里只给不带解析的兜底文本（导出、目标库缓存缺失时的降级）。
const ID_LIST_FORMAT = (v: CellValue): string => (Array.isArray(v) ? (v as string[]).join(", ") : "");

/** FieldType → spec。写成全量 Record 是为了让「新类型没补 spec」在编译期暴露。 */
export const FIELD_KINDS: Record<FieldType, FieldKindSpec> = {
  text: TEXT_LIKE,
  url: TEXT_LIKE,
  phone: TEXT_LIKE,
  email: TEXT_LIKE,
  number: NUMBER_LIKE,
  progress: {
    ...NUMBER_LIKE,
    // 0-100 进度：静态展示给整数百分比（带进度条的单元格是 ProgressCell 组件）
    format: (v) => (isNum(v) ? `${Math.round(Math.min(100, Math.max(0, v)))}%` : ""),
    // 粘贴带百分号，且夹到 0-100
    paste: (raw) => numberOutcome(raw, (s) => Math.min(100, Math.max(0, Number(s.replace(/%$/, ""))))),
  },
  rating: {
    ...NUMBER_LIKE,
    // 星级静态展示用实心/空心星，四舍五入与 RatingCell 一致
    format: (v, options) => {
      if (!isNum(v)) return "";
      const max = ratingMax(options);
      const filled = Math.min(max, Math.max(0, Math.round(v)));
      return "★".repeat(filled) + "☆".repeat(max - filled);
    },
    // 负数按 0 星处理（上限留给满星数，由字段 options 决定）
    paste: (raw) => numberOutcome(raw, (s) => Math.max(0, Number(s))),
  },
  currency: {
    ...NUMBER_LIKE,
    // 币种/精度沿用 number options，缺省 CNY 两位小数
    format: (v, options) => {
      if (!isNum(v)) return "";
      const num = options.kind === "number" ? options : undefined;
      const cur = num?.currency.trim();
      return formatNumber(v, {
        kind: "number",
        format: "currency",
        precision: num?.precision ?? 2,
        currency: cur === undefined || cur === "" ? "CNY" : cur,
      });
    },
  },
  date: DATE_LIKE,
  // created_at 不是系统只读字段（迁移历史数据时要能回填创建时间），粘贴按文本原样存 —— 沿用改造前
  // csvValueToCell 的 default 分支行为；last_edited_at 由触发器维护，任何写入都会被覆盖，直接跳过。
  created_at: { ...DATE_LIKE, format: (v) => formatDate(v, false), paste: textOutcome },
  last_edited_at: {
    ...DATE_LIKE,
    format: (v) => formatDate(v, false),
    paste: () => SKIP,
    groupable: false,
    optionBearing: false,
  },
  single_select: {
    validate: (v) => isStr(v),
    emptyValue: () => null,
    format: (v, options) => {
      if (!isStr(v)) return "";
      return options.kind === "select" ? (options.options.find((o) => o.id === v)?.name ?? v) : v;
    },
    paste: (raw) => {
      const v = raw.trim();
      return optionNamesOutcome(v === "" ? [] : [v]);
    },
    filterOps: ["is_empty", "is_not_empty", "equals", "not_equals"],
    domain: "text",
    groupable: true,
    optionBearing: true,
  },
  multi_select: {
    validate: (v) => isIdList(v),
    emptyValue: () => [],
    // 选项 id → 名称（导出/看板卡片等没有 SelectChips 的场合）；选项被删则降级显示 id
    format: (v, options) => {
      if (!Array.isArray(v)) return "";
      const ids = v.filter((x): x is string => typeof x === "string");
      if (options.kind !== "select") return ids.join(", ");
      return ids.map((id) => options.options.find((o) => o.id === id)?.name ?? id).join(", ");
    },
    // 一格多值用 ; 或 | 分隔（与导出侧 selectCellToText 的分隔符成对）
    paste: (raw) =>
      optionNamesOutcome(
        raw
          .split(/[;|]/)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains"],
    domain: "list",
    groupable: true,
    optionBearing: true,
  },
  checkbox: {
    validate: (v) => typeof v === "boolean",
    emptyValue: () => false,
    format: (v) => (v ? "✓" : ""),
    paste: (raw) => {
      const v = raw.trim();
      if (v === "") return VALUE_NULL;
      return { kind: "value", value: /^(true|是|✓|1)$/i.test(v) };
    },
    filterOps: ["checked", "unchecked"],
    domain: "boolean",
    // 只有 true/false 两个桶，分组没有价值
    groupable: false,
    optionBearing: false,
  },
  relation: {
    validate: (v) => isIdList(v),
    emptyValue: () => [],
    format: ID_LIST_FORMAT,
    // 单元格存对端行 id，剪贴板文本给不出可对应的 id
    paste: () => SKIP,
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains"],
    domain: "list",
    groupable: false,
    optionBearing: false,
  },
  // 以下三类无存储值：公式/汇总/反向关系由渲染时实时计算，单元格校验只是防御性放行
  formula: {
    validate: (v) => isNum(v),
    emptyValue: () => null,
    format: (v, options) => {
      // 公式值由 computeFormula 算好传入，可能是数值/文本/布尔（IF/CONCAT/比较等）
      if (isNum(v)) return formatNumber(v, numberOpts(options));
      if (typeof v === "boolean") return v ? "✓" : "";
      if (isStr(v)) return v;
      return "";
    },
    paste: () => SKIP,
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"],
    domain: "computed",
    groupable: false,
    optionBearing: false,
  },
  rollup: {
    validate: (v) => isStr(v) || isNum(v),
    emptyValue: () => null,
    // 汇总值由 computeRollup 算好传入，已经是展示文本
    format: (v) => (Array.isArray(v) ? (v as string[]).join(",") : String(v)),
    paste: () => SKIP,
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"],
    domain: "computed",
    groupable: false,
    optionBearing: false,
  },
  reverse_relation: {
    validate: (v) => isIdList(v),
    emptyValue: () => [],
    format: ID_LIST_FORMAT,
    paste: () => SKIP,
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"],
    domain: "computed",
    groupable: false,
    optionBearing: false,
  },
  attachment: {
    // 附件单元格存 [{name,path}]；老数据或脏数据里可能有裸字符串，一律判为非法
    validate: (v) =>
      Array.isArray(v) &&
      v.every(
        (x) =>
          typeof x === "object" &&
          typeof (x as { name?: unknown }).name === "string" &&
          typeof (x as { path?: unknown }).path === "string",
      ),
    emptyValue: () => [],
    format: (v) =>
      attachmentRefs(v)
        .map((a) => a.name)
        .join(", "),
    // 文本粘贴给不出文件：CSV 导入里的附件列走「文件名匹配 assets 复制」另一条路径
    paste: () => SKIP,
    filterOps: ["is_empty", "is_not_empty", "contains", "not_contains", "equals", "not_equals"],
    domain: "list",
    groupable: false,
    optionBearing: false,
  },
};

/** 查表入口：field_type 来自数据库，可能是旧版本写入的未知串，按文本降级而不是抛错/渲染崩溃 */
export function fieldKind(type: FieldType): FieldKindSpec {
  const table: Partial<Record<FieldType, FieldKindSpec>> = FIELD_KINDS;
  return table[type] ?? TEXT_LIKE;
}

export function canGroupByKind(type: FieldType): boolean {
  return fieldKind(type).groupable && !isReadonlyType(type);
}

/** 该类型的 options 是否是一个选项列表（单选/多选） */
export function isOptionBearing(type: FieldType): boolean {
  return fieldKind(type).optionBearing;
}

/** 日期语义（含系统时间戳）：筛选的比较符走「按天聚拢 + 相对日期」路径 */
export function isDateKind(type: FieldType): boolean {
  return fieldKind(type).domain === "date";
}
