import type { CellValue, FieldOptions, FieldType, SelectOption } from "@/types/database";

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
    case "checkbox":
      return typeof value === "boolean";
    case "multi_select":
    case "relation":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
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
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Math.max(0, precision) }).format(value);
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
      if (typeof value !== "number") return "";
      return formatNumber(value, options?.kind === "number" ? options : { kind: "number", format: "decimal", precision: 2, currency: "CNY" });
    case "checkbox":
      return value ? "✓" : "";
    case "multi_select":
      return Array.isArray(value) ? value.join(", ") : "";
    case "relation":
      return Array.isArray(value) ? value.length + " 项" : "";
    case "date":
    case "created_at":
    case "last_edited_at": {
      if (typeof value !== "string") return "";
      const d = new Date(value.endsWith("Z") ? value : value + "Z");
      if (Number.isNaN(d.getTime())) return value;
      const includeTime = type !== "created_at" && type !== "last_edited_at" && options?.kind === "date" && options.include_time;
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

export function defaultOptionsFor(type: FieldType): FieldOptions {
  switch (type) {
    case "single_select":
    case "multi_select":
      return { kind: "select", options: [] };
    case "number":
      return { kind: "number", format: "decimal", precision: 2, currency: "CNY" };
    case "date":
      return { kind: "date", include_time: false };
    case "relation":
      return { kind: "relation", target_view_id: null };
    default:
      return { kind: "none" };
  }
}

/** 判断字段是否为附件类型（field_type=url 但 options 标记 attachment） */
export function isAttachmentField(field: { options: string }): boolean {
  return parseFieldOptions(field.options).kind === "attachment";
}

export function newSelectOption(name: string): SelectOption {
  const palette = ["blue", "green", "orange", "purple", "red", "yellow", "gray"];
  return { id: "opt_" + crypto.randomUUID().slice(0, 8), name, color: palette[Math.floor(Math.random() * palette.length)] };
}