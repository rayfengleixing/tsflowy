import { isReadonlyType, type CellValue, type DatabaseField, type FieldType } from "@/types/database";
import { parseFieldOptions, ratingMax, sameCellValue } from "./database-values";

// 批量改值（勾选多行 → 一次改同一字段）的纯逻辑层。
// 拆出来的理由：交互在 GridView 里（.tsx，要测得单独开 jsdom 环境），
// 而「草稿 → 单元格值」和「按当前值合并」这两段是真会算错的：
// 数字草稿可能是空串/NaN，日期要按字段是否含时刻决定编码，多选追加要保住已有项的顺序。

export type BulkOp = "set" | "clear" | "add" | "remove" | "toggle";

/** 值控件的形态：由字段类型和当前操作一起决定（清空/取反不需要值） */
export type BulkValueKind = "none" | "text" | "number" | "date" | "bool" | "single_option" | "multi_option";

/** 用户在弹窗里填的目标值草稿；四种控件各用各自的那一格，切字段时整体重置 */
export interface BulkDraft {
  text: string;
  bool: boolean;
  option: string;
  options: string[];
}

export function emptyBulkDraft(): BulkDraft {
  return { text: "", bool: true, option: "", options: [] };
}

/** 批量改不动的字段：只读列（公式/汇总/反向关系/最后编辑时间）没有可写的存储值，
 *  附件要文件对话框、关联要行选择器——两者在「N 行填同一个值」的语义下都不成立 */
const NOT_BULK_EDITABLE: FieldType[] = ["attachment", "relation"];

export function bulkEditable(field: DatabaseField): boolean {
  return !isReadonlyType(field.field_type) && !NOT_BULK_EDITABLE.includes(field.field_type);
}

export function bulkOpsFor(field: DatabaseField): BulkOp[] {
  if (!bulkEditable(field)) return [];
  // 复选框的「设为」等价于先取反再核对，默认给取反更顺手
  if (field.field_type === "checkbox") return ["toggle", "set", "clear"];
  if (field.field_type === "multi_select") return ["set", "add", "remove", "clear"];
  return ["set", "clear"];
}

export function bulkValueKind(field: DatabaseField, op: BulkOp): BulkValueKind {
  if (op === "clear" || op === "toggle") return "none";
  switch (field.field_type) {
    case "checkbox":
      return "bool";
    case "single_select":
    case "status":
      return "single_option";
    case "multi_select":
      return "multi_option";
    case "number":
    case "currency":
    case "progress":
    case "rating":
      return "number";
    case "date":
    case "created_at":
      return "date";
    default:
      return "text";
  }
}

function toNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 日期草稿 → 单元格编码：含时刻的字段存 ISO 串，纯日期取前 10 位（与 DateCellEditor 一致） */
function toDate(text: string, includeTime: boolean): string | null {
  const t = text.trim();
  if (!t) return null;
  if (!includeTime) return t.length >= 10 ? t.slice(0, 10) : null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 草稿 → 目标值；返回 null 表示「还没填好」，此时不能应用（清空这一档走 op=clear） */
export function bulkTargetValue(field: DatabaseField, draft: BulkDraft): CellValue {
  switch (field.field_type) {
    case "checkbox":
      return draft.bool;
    case "single_select":
    case "status":
      return draft.option || null;
    case "multi_select":
      return draft.options;
    case "number":
    case "currency":
      return toNumber(draft.text);
    case "progress": {
      const n = toNumber(draft.text);
      return n === null ? null : Math.min(100, Math.max(0, Math.round(n)));
    }
    case "rating": {
      const n = toNumber(draft.text);
      if (n === null) return null;
      const stars = Math.min(ratingMax(parseFieldOptions(field.options)), Math.max(0, Math.round(n)));
      // 0 星就是「没打分」，与单元格编辑器点第一颗再点它回落到的空值一致
      return stars === 0 ? null : stars;
    }
    case "date":
    case "created_at": {
      const opts = parseFieldOptions(field.options);
      return toDate(draft.text, opts.kind === "date" && opts.include_time);
    }
    default: {
      const t = draft.text.trim();
      return t || null;
    }
  }
}

/** 只保留字符串项并按首次出现去重：非字符串项原样留着，多选里混进别的东西时不误删 */
function optionIds(value: CellValue): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) if (typeof item === "string") seen.add(item);
  return [...seen];
}

function applyBulkOp(op: BulkOp, target: CellValue, current: CellValue): CellValue {
  switch (op) {
    case "clear":
      return null;
    case "toggle":
      return current !== true;
    // 追加/移除以「当前值」为基准合并：追加把新选项接在后面、原值不动，移除只挑掉选中的那几项
    // （与删除选项时清理引用的 clearRemovedOptionRefs 同一套约定：非字符串项原样保留）
    case "add": {
      const has = new Set(optionIds(current));
      const added = optionIds(target).filter((id) => !has.has(id));
      return [...(Array.isArray(current) ? current : []), ...added];
    }
    case "remove": {
      const gone = new Set(optionIds(target));
      return (Array.isArray(current) ? current : []).filter((x) => typeof x !== "string" || !gone.has(x));
    }
    default:
      return target;
  }
}

export interface BulkUpdate {
  rowId: string;
  fieldId: string;
  value: CellValue;
}

/** 逐行算出新值，跳过本来就是这个值的行——弹窗提示「已修改 N 行」要数得准 */
export function buildBulkUpdates(args: {
  field: DatabaseField;
  op: BulkOp;
  target: CellValue;
  rowIds: string[];
  readCell: (rowId: string, fieldId: string) => CellValue | undefined;
}): BulkUpdate[] {
  const { field, op, target, rowIds, readCell } = args;
  const updates: BulkUpdate[] = [];
  for (const rowId of rowIds) {
    const current = readCell(rowId, field.id) ?? null;
    const next = applyBulkOp(op, target, current);
    if (sameCellValue(current, next)) continue;
    updates.push({ rowId, fieldId: field.id, value: next });
  }
  return updates;
}
