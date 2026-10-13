import { viewApi } from "@/lib/db";
import { logger } from "@/lib/logger";
import { flattenTree } from "@/lib/tree";
import type { View, ViewNode } from "@/types/models";
import type { WorkspaceGet } from "./types";

const TABS_KEY = (wsId: string) => `ui:tabs:${wsId}`;
const CURRENT_KEY = (wsId: string) => `ui:current_view:${wsId}`;
const SPLIT_KEY = (wsId: string) => `ui:split_view:${wsId}`;

/** 标签页/当前视图写回 app_settings 的 300ms 去抖（避免每次 closeTab/reorderTabs 写 DB） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPendingWs: string | null = null;
let persistPendingTabs: string[] | null = null;
let persistPendingCurrent: string | null | undefined = undefined; // undefined=未变化；null=清空
let persistPendingSplit: string | null | undefined = undefined; // undefined=未变化；null=清空

function schedulePersistUi(wsId: string, tabIds: string[], currentViewId: string | null, splitViewId: string | null) {
  persistPendingWs = wsId;
  persistPendingTabs = tabIds;
  persistPendingCurrent = currentViewId;
  persistPendingSplit = splitViewId;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const wsId2 = persistPendingWs;
    const tabs2 = persistPendingTabs;
    const cur2 = persistPendingCurrent;
    const split2 = persistPendingSplit;
    persistTimer = null;
    persistPendingWs = null;
    persistPendingTabs = null;
    persistPendingCurrent = undefined;
    persistPendingSplit = undefined;
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
      } catch (e) {
        logger.warn("WorkspaceStore", "persist tabs failed", wsId2, e);
      }
    })();
  }, 300);
}

/** 立即把挂起的 tabs/current 写回 app_settings（切换空间与关窗前冲刷共用），无挂起时快速返回 */
export async function flushPendingUiPersist(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const wsId = persistPendingWs;
  const tabs = persistPendingTabs;
  const cur = persistPendingCurrent;
  const split = persistPendingSplit;
  persistPendingWs = null;
  persistPendingTabs = null;
  persistPendingCurrent = undefined;
  persistPendingSplit = undefined;
  if (!wsId || !tabs) return;
  try {
    await viewApi.setSetting(TABS_KEY(wsId), JSON.stringify(tabs));
    if (cur !== undefined) {
      await viewApi.setSetting(CURRENT_KEY(wsId), cur ?? "");
    }
    if (split !== undefined) {
      await viewApi.setSetting(SPLIT_KEY(wsId), split ?? "");
    }
  } catch (e) {
    logger.warn("WorkspaceStore", "flush pending tabs failed", wsId, e);
  }
}

export async function loadTabsForWs(
  wsId: string,
  tree: ViewNode[],
): Promise<{ tabs: View[]; currentViewId: string | null; splitViewId: string | null }> {
  try {
    const [tabsRaw, curRaw, splitRaw] = await Promise.all([
      viewApi.getSetting(TABS_KEY(wsId)),
      viewApi.getSetting(CURRENT_KEY(wsId)),
      viewApi.getSetting(SPLIT_KEY(wsId)),
    ]);
    const ids: string[] = tabsRaw ? (JSON.parse(tabsRaw) as string[]) : [];
    const byId = new Map<string, ViewNode>();
    for (const n of flattenTree(tree)) byId.set(n.id, n);
    const tabs = ids.map((i) => byId.get(i)).filter(Boolean) as ViewNode[];
    let currentViewId = curRaw ?? null;
    if (currentViewId && !byId.has(currentViewId)) currentViewId = null;
    // 若持久化中没有 current，但 tabs 有，默认第一个
    if (!currentViewId && tabs.length > 0) currentViewId = tabs[0].id;
    // split 必须仍在树里且不与主视图同页（同页并排无意义，且 openInSplit 从不产生这种组合）
    let splitViewId: string | null = splitRaw?.length ? splitRaw : null;
    if (splitViewId && (!byId.has(splitViewId) || splitViewId === currentViewId)) splitViewId = null;
    return { tabs, currentViewId, splitViewId };
  } catch (e) {
    logger.warn("WorkspaceStore", "load tabs failed", wsId, e);
    return { tabs: [], currentViewId: null, splitViewId: null };
  }
}

// 把 tabs + current 状态根据 ids 计算并 schedule 持久化（所有状态变更都走这个 helper 统一）
export function persistNow(get: WorkspaceGet): void {
  const { currentWorkspaceId, tabs, currentViewId, splitViewId } = get();
  if (!currentWorkspaceId) return;
  schedulePersistUi(
    currentWorkspaceId,
    tabs.map((v) => v.id),
    currentViewId,
    splitViewId,
  );
}
