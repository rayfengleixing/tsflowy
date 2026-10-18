import { fieldKind, STATUS_TONE_COLOR } from "./field-kinds";
import { isReadonlyType } from "@/types/database";
import type { CellValue, DatabaseField, FieldOptions, FieldType, SelectOption, StatusTone } from "@/types/database";

// 字段值序列化/展示（项目说明书 7.2 / 11 节：纯逻辑，Vitest 单测）
// database_cells.value 统一存 JSON 字符串；空单元格为 "null"
// 逐类型的语义已收进 field-kinds.ts 注册表，这里只保留与类型无关的编解码和稳定导出面。

export {
  attachmentRefs,
  formatNumber,
  isDoneOption,
  isOptionBearing,
  isSingleOptionKind,
  ratingMax,
  STATUS_TONE_COLOR,
  STATUS_TONES,
  statusToneOf,
} from "./field-kinds";

/** 稀疏映射取值：`Record<string, T>` 的索引签名看不出「这一行没有条目」，
 *  用 in 判定才能拿到真正的 undefined（项目未开 noUncheckedIndexedAccess）。 */
export function sparseGet<T>(map: Record<string, T>, key: string): T | undefined {
  return key in map ? map[key] : undefined;
}

export function serializeValue(_type: FieldType, value: CellValue): string {
  return JSON.stringify(value);
}

/** 单元格值的同值判定（数组/附件引用按内容比较）：用于跳过无变化的提交 */
export function sameCellValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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

/** 落库前的类型闸门。
 *  编辑器控件、粘贴解析与 AI 归一各自都会把值收成正确形态，这一层兜的是绕过它们的路径：
 *  历史脏数据被原样回写、外部工具改过的行、以后新增的写入口。
 *  只读列（公式/汇总/反向关系/触发器时间）的存储值由计算或触发器生成，不参与校验；
 *  字段查不到（store 尚未加载完）时也放行，让写库那侧报错比这里误判更准。 */
export function cellWriteTypeSafe(field: DatabaseField | undefined, value: CellValue): boolean {
  if (!field || isReadonlyType(field.field_type)) return true;
  return validateCellValue(field.field_type, value);
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

/** 新建选项：status 字段按阶段取固定配色，其余类型随机取色 */
export function newSelectOption(name: string, tone?: StatusTone): SelectOption {
  const palette = ["blue", "green", "orange", "purple", "red", "yellow", "gray"];
  return {
    id: "opt_" + crypto.randomUUID().slice(0, 8),
    name,
    color: tone ? STATUS_TONE_COLOR[tone] : palette[Math.floor(Math.random() * palette.length)],
    // 非 status 字段不写 tone：JSON 序列化时 undefined 的键会被丢掉，不会污染选项数据
    tone,
  };
}

/** 看板/日历分组展示用的选项形态（board-calendar 纯逻辑层避免依赖完整字段） */
export type SelectOptionLike = SelectOption;
