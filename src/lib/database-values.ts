import type { AttachmentRef, CellValue, FieldOptions, FieldType, SelectOption } from "@/types/database";

// 字段值序列化/展示（项目说明书 7.2 / 11 节：纯逻辑，Vitest 单测）
// database_cells.value 统一存 JSON 字符串；空单元格为 "null"

export function serializeValue(_type: FieldType, value: CellValue): string {
  return JSON.stringify(value);
}

export function deserializeValue(_type: FieldType, raw: string): CellValue {
  try {
    return JSON.parse(raw) as CellValue;
  } catch {
    return null;
  }
}

/** 新建单元格的默认值 */
export function defaultValue(type: FieldType): CellValue {
  switch (type) {
    case "checkbox":
      return false;
    case "multi_select":
    case "relation":
    case "attachment":
      return [];
    default:
      return null;
  }
}

/** 类型校验：值与字段类型匹配（空值恒合法） */
export function validateCellValue(type: FieldType, value: CellValue): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "text":
    case "url":
    case "phone":
    case "email":
    case "date":
    case "single_select":
    case "created_at":
    case "last_edited_at":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "formula":
      // 公式字段无存储值（展示时实时计算），此处仅防御性放行
      return typeof value === "number" && Number.isFinite(value);
    case "rollup":
      // 汇总字段同样无存储值；聚合结果按字符串展示，防御性放行
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    case "reverse_relation":
      // 反向关系无存储值，渲染时实时反查；防御性放行（值为对端行 id 数组）
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "attachment":
      // 附件单元格存 [{name,path}]；老数据或脏数据里可能有裸字符串，一律判为非法
      return (
        Array.isArray(value) &&
        value.every(
          (v) =>
            typeof v === "object" &&
            v !== null &&
            typeof (v as { name?: unknown }).name === "string" &&
            typeof (v as { path?: unknown }).path === "string",
        )
      );
    case "checkbox":
      return typeof value === "boolean";
    case "multi_select":
    case "relation":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

/** 从单元格值里挑出合法的附件引用（容忍脏数据：非对象项直接丢弃） */
export function attachmentRefs(value: CellValue): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is AttachmentRef =>
      typeof v === "object" && v !== null && typeof v.name === "string" && typeof v.path === "string",
  );
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

/** 展示用文本：不同类型不同格式（只读时间字段做本地化） */
export function formatCellValue(type: FieldType, value: CellValue, options?: FieldOptions): string {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case "number":
    case "formula": // 公式值由调用方算好传入（computeFormula），按数字字段格式展示
      if (typeof value !== "number") return "";
      return formatNumber(
        value,
        options?.kind === "number" ? options : { kind: "number", format: "decimal", precision: 2, currency: "CNY" },
      );
    case "checkbox":
      return value ? "✓" : "";
    case "multi_select": {
      // 选项 id → 名称（导出、看板卡片、内嵌表格等静态展示没有 SelectChips 可用）；
      // 选项已删或字段未配置时降级显示原始 id
      if (!Array.isArray(value)) return "";
      const ids = value.filter((v): v is string => typeof v === "string");
      if (options?.kind === "select") {
        return ids.map((id) => options.options.find((o) => o.id === id)?.name ?? id).join(", ");
      }
      return ids.join(", ");
    }
    // 关联单元格存的是对端行 id，真正展示要解析成行标题 —— 由 RelationChips 负责渲染，
    // 这里只给一个不带解析的兜底文本（例如导出、无目标库缓存时的降级）。
    // 反向关系同理：单元格无存储值，真正展示由 ReverseRelationChips 解析来源行标题。
    case "relation":
    case "reverse_relation":
      return Array.isArray(value) ? value.join(", ") : "";
    // 汇总值由 computeRollup 算好传入，已经是展示文本
    case "rollup":
      return String(value);
    // 附件单元格存 [{name,path}]：静态展示只给文件名串（导出/看板卡片等无 AttachmentChips 时）
    case "attachment":
      return attachmentRefs(value)
        .map((a) => a.name)
        .join(", ");
    case "date":
    case "created_at":
    case "last_edited_at": {
      if (typeof value !== "string") return "";
      const d = new Date(value.endsWith("Z") ? value : value + "Z");
      if (Number.isNaN(d.getTime())) return value;
      const includeTime =
        type !== "created_at" && type !== "last_edited_at" && options?.kind === "date" && options.include_time;
      return includeTime ? d.toLocaleString() : d.toLocaleDateString();
    }
    case "single_select": {
      // 选项 id → 名称
      if (typeof value !== "string") return "";
      if (options?.kind === "select") {
        return options.options.find((o) => o.id === value)?.name ?? value;
      }
      return value;
    }
    default:
      return String(value);
  }
}

// ---------- 字段 options 解析（database_fields.options JSON） ----------

export function parseFieldOptions(raw: string | null | undefined): FieldOptions {
  if (!raw) return { kind: "none" };
  try {
    const obj = JSON.parse(raw) as FieldOptions;
    if (obj && typeof obj === "object" && "kind" in obj) return obj;
  } catch {
    // fallthrough
  }
  return { kind: "none" };
}

export function newSelectOption(name: string): SelectOption {
  const palette = ["blue", "green", "orange", "purple", "red", "yellow", "gray"];
  return {
    id: "opt_" + crypto.randomUUID().slice(0, 8),
    name,
    color: palette[Math.floor(Math.random() * palette.length)],
  };
}

/** 看板/日历分组展示用的选项形态（board-calendar 纯逻辑层避免依赖完整字段） */
export type SelectOptionLike = SelectOption;
