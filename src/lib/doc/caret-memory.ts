import { viewApi } from "@/lib/backend/db";
import { logger } from "@/lib/logger";

/**
 * 每页的光标记忆：顶层块序号 + 块内字符偏移 + 该页编辑区滚动位置。
 * 存 app_settings（`ui:carets:<wsId>` 一页一条，按最近使用排序），和 tabs/current_view 同一套约定：
 * 纯本机 UI 状态，不进同步、不动 updated_at，因此不会参与整库 LWW。
 */
export interface CaretMark {
  block: number;
  offset: number;
  scrollTop: number;
}

export type CaretMap = Record<string, CaretMark>;

const CARET_KEY = (wsId: string) => `ui:carets:${wsId}`;

/** 每个空间最多记多少页：再多就从最久没打开的那页开始丢 */
export const CARET_MAX_PAGES = 80;

function asMark(value: unknown): CaretMark | null {
  if (!value || typeof value !== "object") return null;
  const { block, offset, scrollTop } = value as Record<string, unknown>;
  if (typeof block !== "number" || typeof offset !== "number") return null;
  if (!Number.isFinite(block) || !Number.isFinite(offset) || block < 0 || offset < 0) return null;
  const top = typeof scrollTop === "number" && Number.isFinite(scrollTop) && scrollTop > 0 ? Math.trunc(scrollTop) : 0;
  return { block: Math.trunc(block), offset: Math.trunc(offset), scrollTop: top };
}

/** 坏 JSON、非对象、字段缺数的条目一律丢掉：记忆读不出来就当没记过，不能让打开页面失败 */
export function parseCaretMap(raw: string | null | undefined): CaretMap {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: CaretMap = {};
  for (const [viewId, value] of Object.entries(data as Record<string, unknown>)) {
    const mark = asMark(value);
    if (mark) out[viewId] = mark;
  }
  return out;
}

/**
 * 写一条并做 LRU 修剪：刚写的挪到末尾，超容量从头（最久未用）丢。
 * 顺序即新鲜度，所以记录里不需要时间戳字段。
 */
export function putCaret(map: CaretMap, viewId: string, mark: CaretMark, cap: number = CARET_MAX_PAGES): CaretMap {
  const entries: [string, CaretMark][] = [];
  for (const [id, value] of Object.entries(map)) if (id !== viewId) entries.push([id, value]);
  entries.push([viewId, mark]);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - cap)));
}

export async function readCaret(wsId: string, viewId: string): Promise<CaretMark | null> {
  try {
    const map = parseCaretMap(await viewApi.getSetting(CARET_KEY(wsId)));
    // 下标在类型上不是 undefined（项目没开 noUncheckedIndexedAccess），运行时可能是缺的
    if (!(viewId in map)) return null;
    return asMark(map[viewId]);
  } catch (e: unknown) {
    logger.warn("caret memory: read failed", wsId, viewId, e);
    return null;
  }
}

/**
 * 读-改-写不能交错：两个分栏同时卸载时各自读整张表再写回，后写的那份会把前一份盖掉。
 * 写本身很轻（一条 UPDATE），整条链串起来即可。返回的 promise 供关窗冲刷 await。
 */
let chain: Promise<void> = Promise.resolve();

export function writeCaret(wsId: string, viewId: string, mark: CaretMark): Promise<void> {
  const run = chain.then(async () => {
    const raw = await viewApi.getSetting(CARET_KEY(wsId));
    const next = putCaret(parseCaretMap(raw), viewId, mark);
    await viewApi.setSetting(CARET_KEY(wsId), JSON.stringify(next));
  });
  const outcome = run.catch((e: unknown) => {
    logger.warn("caret memory: persist failed", wsId, viewId, e);
  });
  chain = outcome;
  return outcome;
}
