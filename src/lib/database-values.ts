import { fieldKind } from "./field-kinds";
import type { CellValue, FieldOptions, FieldType, SelectOption } from "@/types/database";

// 字段值序列化/展示（项目说明书 7.2 / 11 节：纯逻辑，Vitest 单测）
// database_cells.value 统一存 JSON 字符串；空单元格为 "null"
// 逐类型的语义已收进 field-kinds.ts 注册表，这里只保留与类型无关的编解码和稳定导出面。

export { attachmentRefs, formatNumber, isOptionBearing, ratingMax } from "./field-kinds";

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
  return fieldKind(type).emptyValue();
}

/** 类型校验：值与字段类型匹配（空值恒合法） */
export function validateCellValue(type: FieldType, value: CellValue): boolean {
  if (value === null) return true;
  return fieldKind(type).validate(value);
}

/** 展示用文本：不同类型不同格式（只读时间字段做本地化） */
export function formatCellValue(type: FieldType, value: CellValue, options?: FieldOptions): string {
  if (value === null || value === "") return "";
  return fieldKind(type).format(value, options ?? { kind: "none" });
}

// ---------- 字段 options 解析（database_fields.options JSON） ----------

export function parseFieldOptions(raw: string | null | undefined): FieldOptions {
  if (!raw) return { kind: "none" };
  try {
    const obj = JSON.parse(raw) as FieldOptions | null;
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
