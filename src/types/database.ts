// 与 migrations/001_init.sql 数据库三表对应（项目说明书 7.2 字段值编码）
import type { LayoutType } from "./models";

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "single_select"
  | "multi_select"
  | "checkbox"
  | "url"
  | "phone"
  | "email"
  | "created_at"
  | "last_edited_at";

// 字段类型可选列表（附件字段完整上传/落库功能未实现，保留在 FieldType 中兼容历史数据；
// created_at / last_edited_at 由触发器自动维护（READONLY_FIELD_TYPES）。
export const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "single_select",
  "multi_select",
  "checkbox",
  "url",
  "phone",
  "email",
  "created_at",
  "last_edited_at",
];

/** 时间戳/系统字段：创建时间手动改保留历史值；最后编辑时间由触发器强制刷新，不能在 UI 改 */
export const READONLY_FIELD_TYPES: FieldType[] = ["last_edited_at"];

export function isReadonlyType(t: FieldType): boolean {
  return READONLY_FIELD_TYPES.includes(t);
}

export interface DatabaseField {
  id: string;
  database_view_id: string;
  name: string;
  field_type: FieldType;
  options: string; // JSON（FieldOptions）
  width: number;
  is_hidden: number; // 0/1
  position: number;
}

export interface DatabaseRow {
  id: string;
  database_view_id: string;
  position: number;
  document_id: string | null; // 行详情文档 view_id；NULL=未创建
  created_at: number;
  updated_at: number;
}

/**
 * 单元格值（说明书 7.2 编码，database_cells.value 为 JSON 字符串）：
 * - text/url/phone/email/date/single_select → string
 * - number → number
 * - checkbox → boolean
 * - multi_select → string[]
 * - 空单元格 → null
 */
export type CellValue = string | number | boolean | string[] | null;

/** 单选/多选选项 */
export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

/** 字段 options JSON 的结构化形态 */
export type FieldOptions =
  | { kind: "select"; options: SelectOption[] } // single_select / multi_select
  | { kind: "number"; format: "integer" | "decimal" | "percent" | "currency"; precision: number; currency: string }
  | { kind: "date"; include_time: boolean }
  | { kind: "none" };

/** 行详情视图的 extra 标记（说明书 12 节风险 7：搜索/侧边栏过滤时排除） */
export const ROW_DETAIL_MARKER = { row_detail: true };

export type { LayoutType };