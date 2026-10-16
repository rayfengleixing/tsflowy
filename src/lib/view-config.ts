import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import {
  MAX_FILTER_DEPTH,
  MAX_GROUP_DEPTH,
  type FilterGroup,
  type FilterMode,
  type FilterNode,
  type FilterSpec,
  type SortSpec,
} from "@/lib/database-query";
import { isAggregateFn, type AggregateFn } from "@/lib/database-aggregate";
import { parseCondFormats, type CondFormatRule } from "@/lib/database-cond-format";
import { registerCloseFlush } from "@/lib/close-flush";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import type { View } from "@/types/models";

// 视图显示配置持久化在 views.extra（JSON）：筛选、排序、看板分组字段、日历日期字段，
// 以及数据库页最后一次停留的视图 id（activeViewId，只写在宿主行上）。
// 这些原先都只是组件里的内存状态，切页/重启即丢。
// extra 同时承载 row_detail 等既有标记，所以写入一律"读改写整份 JSON"，未知键原样保留。

export interface ViewConfig {
  /** 顶层节点：叶子条件或嵌套条件组（组内再按组自己的 mode 组合） */
  filters?: FilterNode[];
  /** 顶层节点的组合方式 */
  filterMode?: FilterMode;
  sorts?: SortSpec[];
  boardFieldId?: string;
  calendarFieldId?: string;
  /** 时间线视图：开始/结束日期字段（结束为空则只画点） */
  timelineStartFieldId?: string;
  timelineEndFieldId?: string;
  /** 表格分组字段（按层级顺序，最多 MAX_GROUP_DEPTH 层；Grid 独有，看板分组是 boardFieldId）。
   *  写入时顺带清掉旧版单层键 groupFieldId，读旧库时它仍会并进本字段。 */
  groupFieldIds?: string[];
  /** 列汇总：field_id → 汇总函数；缺省即该列不显示汇总 */
  aggregates?: Record<string, AggregateFn>;
  /** 条件格式规则（按顺序判定，先到先得）；表格视图独有 */
  condFormats?: CondFormatRule[];
  /** 看板卡片上额外展示的字段 id（按此顺序）；未配置沿用"前 3 个可见字段"启发式，空数组=只显示标题 */
  cardFieldIds?: string[];
  /** 画廊视图：封面图取自哪个附件字段 */
  galleryFieldId?: string;
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

const isFilterMode = (v: unknown): v is FilterMode => v === "and" || v === "or";

/** 组看形状就认得出来：有 children 数组且 mode 合法 */
const isFilterGroupShape = (v: unknown): v is { mode: FilterMode; children: unknown; id?: unknown } =>
  !!v &&
  typeof v === "object" &&
  Array.isArray((v as { children?: unknown }).children) &&
  isFilterMode((v as { mode?: unknown }).mode);

/**
 * 筛选树校验（depth = 这批节点所处的层号，顶层为 1）：
 * 叶子仍按 field_id 认，组缺 id（没法定位编辑）或超出层深上限时只摊平外壳，条件不丢。
 */
function parseFilterNodes(value: unknown, depth: number): FilterNode[] {
  if (!Array.isArray(value)) return [];
  const out: FilterNode[] = [];
  for (const item of value) {
    if (isFilterGroupShape(item)) {
      const children = parseFilterNodes(item.children, depth + 1);
      if (children.length === 0) continue;
      if (depth > MAX_FILTER_DEPTH || !isString(item.id) || !item.id) {
        out.push(...children);
        continue;
      }
      const group: FilterGroup = { id: item.id, mode: item.mode, children };
      out.push(group);
    } else if (isFieldSpec(item)) {
      out.push(item as FilterSpec);
    }
  }
  return out;
}

/** 分组字段序列：去重、按序、截到层数上限（历史脏配置不该把表格切成无数碎块） */
function parseGroupFieldIds(v: unknown, legacy: unknown): string[] | undefined {
  const ids: string[] = [];
  const push = (id: unknown) => {
    if (isString(id) && id && !ids.includes(id) && ids.length < MAX_GROUP_DEPTH) ids.push(id);
  };
  if (Array.isArray(v)) {
    for (const id of v) push(id);
    return ids;
  }
  // 旧配置只有 groupFieldId 一个键
  if (isString(legacy) && legacy) return [legacy];
  return undefined;
}

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
  const filters = Array.isArray(o.filters) ? parseFilterNodes(o.filters, 1) : undefined;
  if (filters) out.filters = filters;
  if (o.filterMode === "and" || o.filterMode === "or") out.filterMode = o.filterMode;
  const sorts = specArray<SortSpec>(o.sorts, isSortSpec);
  if (sorts) out.sorts = sorts;
  // 空串是"清除字段选择"的哨兵写法，读出时归一为未配置
  if (typeof o.boardFieldId === "string" && o.boardFieldId) out.boardFieldId = o.boardFieldId;
  if (typeof o.calendarFieldId === "string" && o.calendarFieldId) out.calendarFieldId = o.calendarFieldId;
  if (typeof o.timelineStartFieldId === "string" && o.timelineStartFieldId)
    out.timelineStartFieldId = o.timelineStartFieldId;
  if (typeof o.timelineEndFieldId === "string" && o.timelineEndFieldId) out.timelineEndFieldId = o.timelineEndFieldId;
  const groupFieldIds = parseGroupFieldIds(o.groupFieldIds, o.groupFieldId);
  if (groupFieldIds) out.groupFieldIds = groupFieldIds;
  if (typeof o.galleryFieldId === "string" && o.galleryFieldId) out.galleryFieldId = o.galleryFieldId;
  const aggregates = parseAggregates(o.aggregates);
  if (aggregates) out.aggregates = aggregates;
  const condFormats = parseCondFormats(o.condFormats);
  if (condFormats) out.condFormats = condFormats;
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
  if (patch.timelineStartFieldId !== undefined) next.timelineStartFieldId = patch.timelineStartFieldId;
  if (patch.timelineEndFieldId !== undefined) next.timelineEndFieldId = patch.timelineEndFieldId;
  if (patch.groupFieldIds !== undefined) {
    next.groupFieldIds = patch.groupFieldIds;
    // 单层分组键已被取代：留着会让下次读取时两个键同时存在（本函数只在有 patch 时才动它）
    delete next.groupFieldId;
  }
  if (patch.galleryFieldId !== undefined) next.galleryFieldId = patch.galleryFieldId;
  if (patch.aggregates !== undefined) next.aggregates = patch.aggregates;
  if (patch.condFormats !== undefined) next.condFormats = patch.condFormats;
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
