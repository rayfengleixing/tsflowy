// 与 migrations/001_init.sql 数据库三表对应（项目说明书 7.2 字段值编码）
import type { LayoutType } from "./models";
import type { AggregateFn } from "@/lib/database-aggregate";

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
  | "last_edited_at"
  | "formula"
  | "relation"
  | "rollup"
  | "reverse_relation";

// 字段类型可选列表（created_at / last_edited_at 由触发器自动维护（READONLY_FIELD_TYPES）。
// formula 由前端按表达式实时计算展示，无存储值，同样只读不可编辑。
// relation 引用另一个数据库视图的行（单元格存对端行 id 数组）；rollup 对关联行做聚合，
// 与 formula 一样无存储值、实时计算。
// reverse_relation 是 relation 的镜像：只读展示「其它表里指向本行的关联行」，同样无存储值。
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
  "formula",
  "relation",
  "rollup",
  "reverse_relation",
];

/** 时间戳/系统字段：创建时间手动改保留历史值；最后编辑时间由触发器强制刷新，不能在 UI 改。
 *  公式/汇总/反向关系均无存储值，渲染时实时计算，UI 只读。 */
export const READONLY_FIELD_TYPES: FieldType[] = ["last_edited_at", "formula", "rollup", "reverse_relation"];

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
 * - multi_select → string[]（选项 id）
 * - relation → string[]（对端行 id）
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
  | { kind: "formula"; formula: string } // 公式表达式，字段引用用 {字段名}
  | { kind: "relation"; target_view_id: string } // 引用的目标视图（宿主 view id）
  | {
      kind: "rollup";
      relation_field_id: string; // 本表上的 relation 字段
      target_field_id: string; // 被汇总的目标表字段
      fn: AggregateFn; // 汇总函数（复用列汇总的候选集）
    }
  // 反向关系：source_view_id 是「来源表」宿主视图，source_field_id 是来源表上
  // 指向本表（当前视图）的 relation 字段；渲染时反查来源行，只读、无存储值。
  | { kind: "reverse_relation"; source_view_id: string; source_field_id: string }
  | { kind: "none" };

export type { LayoutType };
