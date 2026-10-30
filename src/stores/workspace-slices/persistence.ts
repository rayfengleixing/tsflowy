import { viewApi } from "@/lib/backend/db";
import { logger } from "@/lib/logger";
import { flattenTree } from "@/lib/doc/tree";
import type { ViewNode } from "@/types/models";
import type { WorkspaceGet } from "./types";

const TABS_KEY = (wsId: string) => `ui:tabs:${wsId}`;
const CURRENT_KEY = (wsId: string) => `ui:current_view:${wsId}`;
const SPLIT_KEY = (wsId: string) => `ui:split_view:${wsId}`;
const EXPANDED_KEY = (wsId: string) => `ui:expanded:${wsId}`;
const PINNED_KEY = (wsId: string) => `ui:pinned:${wsId}`;

/** 侧栏宽度：全局偏好（跨空间一致），沿用 settings 的 localStorage 存储约定 */
const SIDEBAR_WIDTH_LS = "tsflowy:sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 240;

export function loadSidebarWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_LS);
    if (!v) return DEFAULT_SIDEBAR_WIDTH;
    const n = Number(v);
    return Number.isFinite(n) && n >= 160 && n <= 800 ? n : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function saveSidebarWidth(w: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_LS, String(w));
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

/** 标签页/当前视图/展开/pinned 写回 app_settings 的 300ms 去抖（避免每次 closeTab/reorderTabs 写 DB） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPendingWs: string | null = null;
let persistPendingTabs: string[] | null = null;
let persistPendingCurrent: string | null | undefined = undefined; // undefined=未变化；null=清空
let persistPendingSplit: string | null | undefined = undefined; // undefined=未变化；null=清空
let persistPendingExpanded: string[] | undefined = undefined;
let persistPendingPinned: string[] | undefined = undefined;

function schedulePersistUi(
  wsId: string,
  tabIds: string[],
  currentViewId: string | null,
  splitViewId: string | null,
  expandedIds: string[],
  pinnedIds: string[],
) {
  persistPendingWs = wsId;
  persistPendingTabs = tabIds;
  persistPendingCurrent = currentViewId;
  persistPendingSplit = splitViewId;
  persistPendingExpanded = expandedIds;
  persistPendingPinned = pinnedIds;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const wsId2 = persistPendingWs;
    const tabs2 = persistPendingTabs;
    const cur2 = persistPendingCurrent;
    const split2 = persistPendingSplit;
    const expanded2 = persistPendingExpanded;
    const pinned2 = persistPendingPinned;
    persistTimer = null;
    persistPendingWs = null;
    persistPendingTabs = null;
    persistPendingCurrent = undefined;
    persistPendingSplit = undefined;
    persistPendingExpanded = undefined;
    persistPendingPinned = undefined;
    if (!wsId2 || !tabs2) return;
    void (async () => {
      try {
        await viewApi.setSetting(TABS_KEY(wsId2), JSON.stringify(tabs2));
        if (cur2 !== undefined) {
          if (cur2 === null) {
            await viewApi.setSetting(CURRENT_KEY(wsId2), "");
          } else {
            await viewApi.setSetting(CURRENT_KEY(wsId2), cur2);
          }
        }
        if (split2 !== undefined) {
          await viewApi.setSetting(SPLIT_KEY(wsId2), split2 ?? "");
        }
        if (expanded2 !== undefined) {
          await viewApi.setSetting(EXPANDED_KEY(wsId2), JSON.stringify(expanded2));
        }
        if (pinned2 !== undefined) {
          await viewApi.setSetting(PINNED_KEY(wsId2), JSON.stringify(pinned2));
        }
      } catch (e) {
        logger.warn("WorkspaceStore", "persist tabs failed", wsId2, e);
      }
    })();
  }, 300);
}

/** 立即把挂起的 tabs/current/split/expanded/pinned 写回 app_settings（切换空间与关窗前冲刷共用），无挂起时快速返回 */
export async function flushPendingUiPersist(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const wsId = persistPendingWs;
  const tabs = persistPendingTabs;
  const cur = persistPendingCurrent;
  const split = persistPendingSplit;
  const expanded = persistPendingExpanded;
  const pinned = persistPendingPinned;
  persistPendingWs = null;
  persistPendingTabs = null;
  persistPendingCurrent = undefined;
  persistPendingSplit = undefined;
  persistPendingExpanded = undefined;
  persistPendingPinned = undefined;
  if (!wsId || !tabs) return;
  try {
    await viewApi.setSetting(TABS_KEY(wsId), JSON.stringify(tabs));
    if (cur !== undefined) {
      await viewApi.setSetting(CURRENT_KEY(wsId), cur ?? "");
    }
    if (split !== undefined) {
      await viewApi.setSetting(SPLIT_KEY(wsId), split ?? "");
    }
    if (expanded !== undefined) {
      await viewApi.setSetting(EXPANDED_KEY(wsId), JSON.stringify(expanded));
    }
    if (pinned !== undefined) {
      await viewApi.setSetting(PINNED_KEY(wsId), JSON.stringify(pinned));
    }
  } catch (e) {
    logger.warn("WorkspaceStore", "flush pending tabs failed", wsId, e);
  }
}

export interface RestoredUi {
  tabs: ViewNode[];
  currentViewId: string | null;
  splitViewId: string | null;
  /** null = 没有持久化过（首次进入），调用方可选择默认展开根级；空 Set = 用户显式全部折叠 */
  expanded: Set<string> | null;
  pinned: Set<string>;
}

export async function loadTabsForWs(wsId: string, tree: ViewNode[]): Promise<RestoredUi> {
  const empty: RestoredUi = {
    tabs: [],
    currentViewId: null,
    splitViewId: null,
    expanded: null,
    pinned: new Set<string>(),
  };
  try {
    const [tabsRaw, curRaw, splitRaw, expandedRaw, pinnedRaw] = await Promise.all([
      viewApi.getSetting(TABS_KEY(wsId)),
      viewApi.getSetting(CURRENT_KEY(wsId)),
      viewApi.getSetting(SPLIT_KEY(wsId)),
      viewApi.getSetting(EXPANDED_KEY(wsId)),
      viewApi.getSetting(PINNED_KEY(wsId)),
    ]);
    const ids: string[] = tabsRaw ? (JSON.parse(tabsRaw) as string[]) : [];
    const byId = new Map<string, ViewNode>();
    for (const n of flattenTree(tree)) byId.set(n.id, n);
    const tabs = ids.map((i) => byId.get(i)).filter(Boolean) as ViewNode[];
    let currentViewId = curRaw ?? null;
    if (currentViewId && !byId.has(currentViewId)) currentViewId = null;
    if (!currentViewId && tabs.length > 0) currentViewId = tabs[0].id;
    let splitViewId: string | null = splitRaw?.length ? splitRaw : null;
    if (splitViewId && (!byId.has(splitViewId) || splitViewId === currentViewId)) splitViewId = null;

    // expanded：解析失败或节点已删的静默忽略；空数组 → 空 Set（与「未持久化」的 null 区分）
    let expanded: Set<string> | null = null;
    if (expandedRaw) {
      try {
        const arr = JSON.parse(expandedRaw) as unknown;
        if (Array.isArray(arr)) {
          expanded = new Set<string>();
          for (const id of arr) {
            if (typeof id === "string" && byId.has(id)) expanded.add(id);
          }
        }
      } catch {
        /* 结构损坏视同未持久化，走默认根级展开 */
      }
    }
    // pinned：只保留仍在 tabs 里的 id（关掉的标签 pin 自动失效）
    const pinned = new Set<string>();
    if (pinnedRaw) {
      try {
        const arr = JSON.parse(pinnedRaw) as unknown;
        const inTabs = new Set(tabs.map((v) => v.id));
        if (Array.isArray(arr)) {
          for (const id of arr) {
            if (typeof id === "string" && inTabs.has(id)) pinned.add(id);
          }
        }
      } catch {
        /* 忽略 */
      }
    }
    return { tabs, currentViewId, splitViewId, expanded, pinned };
  } catch (e) {
    logger.warn("WorkspaceStore", "load tabs failed", wsId, e);
    return empty;
  }
}

/** 把 tabs + current + split + expanded + pinned 状态根据 ids 计算并 schedule 持久化（所有状态变更都走这个 helper 统一） */
export function persistNow(get: WorkspaceGet): void {
  const { currentWorkspaceId, tabs, currentViewId, splitViewId, expanded, pinnedTabIds } = get();
  if (!currentWorkspaceId) return;
  schedulePersistUi(
    currentWorkspaceId,
    tabs.map((v) => v.id),
    currentViewId,
    splitViewId,
    [...expanded],
    [...pinnedTabIds],
  );
}

/** 关闭栈容量（Ctrl+Shift+T 最多回溯 10 个）——导出供纯函数与测试共享 */
export const CLOSED_STACK_LIMIT = 10;

/** 记录一次「刚被关闭的 tab id」：栈末尾最近；已存在不重复入栈；超出丢最旧 */
export function pushClosedId(stack: string[], id: string): string[] {
  const next = stack.filter((x) => x !== id);
  next.push(id);
  if (next.length > CLOSED_STACK_LIMIT) next.splice(0, next.length - CLOSED_STACK_LIMIT);
  return next;
}

/** 弹出最近一次可重开的 id：跳过 validIds 集合外（已删）的历史项，同步清掉栈里失效项 */
export function popReopenable(stack: string[], validIds: Set<string>): { id: string | null; stack: string[] } {
  const next = [...stack];
  while (next.length > 0) {
    const id = next[next.length - 1];
    next.pop();
    if (validIds.has(id)) return { id, stack: next };
  }
  return { id: null, stack: next };
}
