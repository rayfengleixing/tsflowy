import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { FilterMode, FilterSpec, SortSpec } from "@/lib/database-query";
import { isAggregateFn, type AggregateFn } from "@/lib/database-aggregate";
import { registerCloseFlush } from "@/lib/close-flush";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import type { View } from "@/types/models";

// 视图显示配置持久化在 views.extra（JSON）：筛选、排序、看板分组字段、日历日期字段，
// 以及数据库页最后一次停留的视图 id（activeViewId，只写在宿主行上）。
// 这些原先都只是组件里的内存状态，切页/重启即丢。
// extra 同时承载 row_detail 等既有标记，所以写入一律"读改写整份 JSON"，未知键原样保留。

export interface ViewConfig {
  filters?: FilterSpec[];
  filterMode?: FilterMode;
  sorts?: SortSpec[];
  boardFieldId?: string;
  calendarFieldId?: string;
  /** 表格分组字段（Grid 独有；看板分组字段是 boardFieldId） */
  groupFieldId?: string;
  /** 列汇总：field_id → 汇总函数；缺省即该列不显示汇总 */
  aggregates?: Record<string, AggregateFn>;
  /** 看板卡片上额外展示的字段 id（按此顺序）；未配置沿用"前 3 个可见字段"启发式，空数组=只显示标题 */
  cardFieldIds?: string[];
  activeViewId?: string;
}

function asObject(text: string | null | undefined): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(text ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* 损坏的 extra 一律当作没有配置 */
  }
  return {};
}

const isFieldSpec = (v: unknown): boolean => !!v && typeof (v as { field_id?: unknown }).field_id === "string";

const isSortSpec = (v: unknown): boolean =>
  isFieldSpec(v) && ((v as { dir?: unknown }).dir === "asc" || (v as { dir?: unknown }).dir === "desc");

/** 逐元素过滤：畸形条目剔除，其余保留 */
const specArray = <T>(v: unknown, keep: (item: unknown) => boolean = isFieldSpec): T[] | undefined =>
  Array.isArray(v) ? (v.filter(keep) as T[]) : undefined;

const isString = (v: unknown): v is string => typeof v === "string";

/** 列汇总：只收 field_id → 已知函数名，其余条目整条丢弃 */
function parseAggregates(v: unknown): Record<string, AggregateFn> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, AggregateFn> = {};
  for (const [fieldId, fn] of Object.entries(v)) {
    if (fieldId && isAggregateFn(fn)) out[fieldId] = fn;
  }
  return out;
}

/** 纯函数：extra 文本 → 已校验的配置；未知/畸形键忽略 */
export function parseViewConfig(text: string | null | undefined): ViewConfig {
  const o = asObject(text);
  const out: ViewConfig = {};
  const filters = specArray<FilterSpec>(o.filters);
  if (filters) out.filters = filters;
  if (o.filterMode === "and" || o.filterMode === "or") out.filterMode = o.filterMode;
  const sorts = specArray<SortSpec>(o.sorts, isSortSpec);
  if (sorts) out.sorts = sorts;
  // 空串是"清除字段选择"的哨兵写法，读出时归一为未配置
  if (typeof o.boardFieldId === "string" && o.boardFieldId) out.boardFieldId = o.boardFieldId;
  if (typeof o.calendarFieldId === "string" && o.calendarFieldId) out.calendarFieldId = o.calendarFieldId;
  if (typeof o.groupFieldId === "string" && o.groupFieldId) out.groupFieldId = o.groupFieldId;
  const aggregates = parseAggregates(o.aggregates);
  if (aggregates) out.aggregates = aggregates;
  const cardFieldIds = specArray<string>(o.cardFieldIds, isString);
  if (cardFieldIds) out.cardFieldIds = cardFieldIds;
  if (typeof o.activeViewId === "string" && o.activeViewId) out.activeViewId = o.activeViewId;
  return out;
}

/** 纯函数：把 patch 合并进整份 extra 文本，保留 patch 之外的既有键；值为 undefined 的键不动 */
export function mergeViewConfig(text: string | null | undefined, patch: Partial<ViewConfig>): string {
  const next: Record<string, unknown> = { ...asObject(text) };
  if (patch.filters !== undefined) next.filters = patch.filters;
  if (patch.filterMode !== undefined) next.filterMode = patch.filterMode;
  if (patch.sorts !== undefined) next.sorts = patch.sorts;
  if (patch.boardFieldId !== undefined) next.boardFieldId = patch.boardFieldId;
  if (patch.calendarFieldId !== undefined) next.calendarFieldId = patch.calendarFieldId;
  if (patch.groupFieldId !== undefined) next.groupFieldId = patch.groupFieldId;
  if (patch.aggregates !== undefined) next.aggregates = patch.aggregates;
  if (patch.cardFieldIds !== undefined) next.cardFieldIds = patch.cardFieldIds;
  if (patch.activeViewId !== undefined) next.activeViewId = patch.activeViewId;
  return JSON.stringify(next);
}

/**
 * 本会话内各视图 extra 的权威副本。组件拿到的 `view` 来自树快照、不会随写入刷新，
 * 若每次都从 `view.extra` 起算合并，同一视图的第二次写会把第一次的结果丢掉。
 */
const extras = new Map<string, string>();

function baseExtra(view: View): string {
  let e = extras.get(view.id);
  if (e === undefined) {
    e = JSON.stringify(asObject(view.extra));
    extras.set(view.id, e);
  }
  return e;
}

export function readViewConfig(view: View): ViewConfig {
  return parseViewConfig(baseExtra(view));
}

const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const WRITE_DELAY_MS = 400;

async function flushWrites(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = [...pending.entries()];
  pending.clear();
  for (const [id, extra] of batch) {
    try {
      await invoke("view_update_extra", { id, extra });
    } catch (e) {
      logger.error("view-config.write", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  }
}

export function patchViewConfig(view: View, patch: Partial<ViewConfig>): void {
  const merged = mergeViewConfig(baseExtra(view), patch);
  extras.set(view.id, merged);
  pending.set(view.id, merged);
  timer ??= setTimeout(() => void flushWrites(), WRITE_DELAY_MS);
}

registerCloseFlush(flushWrites);
