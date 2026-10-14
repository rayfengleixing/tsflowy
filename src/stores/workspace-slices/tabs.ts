import { viewApi } from "@/lib/db";
import { documentApi } from "@/lib/documents";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { useSettingsStore } from "../settings";
import {
  buildDailyFolderDoc,
  buildDailyNoteDoc,
  dailyNoteNameMatches,
  dailyNoteTitle,
  loadDailyNotesConfig,
  toDateKey,
} from "@/lib/daily-notes";
import type { View } from "@/types/models";
import { findInTree, syncSubpages } from "./tree";
import { persistNow, pushClosedId, popReopenable } from "./persistence";
import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

/** 每日笔记打开串行队列：并发触发（连点、多入口同时调）会各自走一遍「查或建目录」，撞出重复目录页 */
let dailyNoteQueue: Promise<void> = Promise.resolve();

/** 访问历史上限（超过丢最旧，保留最近 50 条） */
const NAV_HISTORY_LIMIT = 50;

/** 记录一次访问到历史栈：截断指针之后的分支，追加当前 id（若与栈顶相同则跳过） */
function recordNav(history: string[], pointer: number, nextId: string): { history: string[]; pointer: number } {
  if (history.length === 0) {
    return { history: [nextId], pointer: 0 };
  }
  const truncated = history.slice(0, pointer + 1);
  if (truncated[truncated.length - 1] === nextId) {
    return { history: truncated, pointer: truncated.length - 1 };
  }
  const next = [...truncated, nextId];
  const drop = Math.max(0, next.length - NAV_HISTORY_LIMIT);
  return { history: next.slice(drop), pointer: next.length - 1 - drop };
}

export const createTabsSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  tabs: [],
  currentViewId: null,
  splitViewId: null,
  splitRatio: 0.5,
  pinnedTabIds: new Set<string>(),
  closedStack: [],
  navHistory: [],
  navPointer: -1,

  openView: (id: string) => {
    const { tree, tabs } = get();
    const node = findInTree(tree, id);
    if (!node) return;
    let changed = false;
    let nextTabs = tabs;
    if (!tabs.some((v) => v.id === id)) {
      nextTabs = [...tabs, node];
      changed = true;
    }
    const cur = get().currentViewId;
    if (changed || cur !== id) {
      const { history, pointer } = recordNav(get().navHistory, get().navPointer, id);
      set({ tabs: nextTabs, currentViewId: id, route: "workspace", navHistory: history, navPointer: pointer });
      persistNow(get);
    } else {
      set({ route: "workspace" });
    }
    // Phase 3.2：异步刷新 visited_at，不阻塞 UI（失败仅 warn，不影响打开流程）
    void viewApi.touchVisited(id).catch(logger.catch("WorkspaceStore.openView", "touchVisited failed", id));
  },

  closeTab: (id: string) => {
    const closing = get().tabs.find((v) => v.id === id);
    const tabs = get().tabs.filter((v) => v.id !== id);
    let currentViewId = get().currentViewId;
    if (currentViewId === id) {
      const idx = get().tabs.findIndex((v) => v.id === id);
      currentViewId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    }
    // 关掉的是副视图则取消并排
    const splitViewId = get().splitViewId === id ? null : get().splitViewId;
    const pinnedTabIds = new Set(get().pinnedTabIds);
    pinnedTabIds.delete(id);
    const closedStack = closing ? pushClosedId(get().closedStack, id) : get().closedStack;
    set({ tabs, currentViewId, splitViewId, pinnedTabIds, closedStack });
    persistNow(get);
  },

  closeAllTabs: () => {
    const pinned = get().pinnedTabIds;
    const kept = get().tabs.filter((v) => pinned.has(v.id));
    let closedStack = get().closedStack;
    for (const v of get().tabs) {
      if (!pinned.has(v.id)) closedStack = pushClosedId(closedStack, v.id);
    }
    const cur = get().currentViewId;
    const stillThere = cur !== null && kept.some((v) => v.id === cur);
    const nextCurrent = stillThere ? cur : (kept[0]?.id ?? null);
    const split = get().splitViewId;
    const nextSplit = split !== null && kept.some((v) => v.id === split) ? split : null;
    set({ tabs: kept, currentViewId: nextCurrent, splitViewId: nextSplit, closedStack });
    persistNow(get);
  },

  closeOtherTabs: (id) => {
    const keep = get().tabs.find((v) => v.id === id);
    if (!keep) return;
    const pinned = get().pinnedTabIds;
    const nextTabs = get().tabs.filter((v) => v.id === id || pinned.has(v.id));
    let closedStack = get().closedStack;
    for (const v of get().tabs) {
      if (v.id !== id && !pinned.has(v.id)) closedStack = pushClosedId(closedStack, v.id);
    }
    const nextSplit = nextTabs.some((v) => v.id === get().splitViewId) ? get().splitViewId : null;
    set({ tabs: nextTabs, currentViewId: id, splitViewId: nextSplit, closedStack });
    persistNow(get);
  },

  togglePinTab: (id) => {
    if (!get().tabs.some((v) => v.id === id)) return;
    const pinned = new Set(get().pinnedTabIds);
    if (pinned.has(id)) pinned.delete(id);
    else pinned.add(id);
    set({ pinnedTabIds: pinned });
    persistNow(get);
  },

  reopenLastClosed: () => {
    const tree = get().tree;
    const stack = get().closedStack;
    const validIds = new Set<string>();
    for (const id of stack) {
      if (findInTree(tree, id)) validIds.add(id);
    }
    const { id, stack: nextStack } = popReopenable(stack, validIds);
    if (!id) {
      set({ closedStack: nextStack });
      return;
    }
    set({ closedStack: nextStack });
    get().openView(id);
  },

  navigateBack: () => {
    const { navHistory, navPointer } = get();
    if (navPointer <= 0 || navHistory.length === 0) return;
    const nextPointer = navPointer - 1;
    const targetId = navHistory[nextPointer];
    const node = findInTree(get().tree, targetId);
    if (!node) {
      // 目标已删：截断到指针之前，让下一次后退落到可用项
      set({ navHistory: navHistory.slice(0, nextPointer), navPointer: nextPointer - 1 });
      return;
    }
    const tabs = get().tabs.some((v) => v.id === targetId) ? get().tabs : [...get().tabs, node];
    set({ navPointer: nextPointer, tabs, currentViewId: targetId, route: "workspace" });
    persistNow(get);
  },

  navigateForward: () => {
    const { navHistory, navPointer } = get();
    if (navPointer < 0 || navPointer >= navHistory.length - 1) return;
    const nextPointer = navPointer + 1;
    const targetId = navHistory[nextPointer];
    const node = findInTree(get().tree, targetId);
    if (!node) {
      set({ navHistory: navHistory.slice(0, nextPointer), navPointer: nextPointer - 1 });
      return;
    }
    const tabs = get().tabs.some((v) => v.id === targetId) ? get().tabs : [...get().tabs, node];
    set({ navPointer: nextPointer, tabs, currentViewId: targetId, route: "workspace" });
    persistNow(get);
  },

  openInSplit: (id) => {
    const { tree, tabs, currentViewId } = get();
    const node = findInTree(tree, id);
    if (!node) return;
    // 还没有主视图时无从对照，退化为普通打开
    if (!currentViewId) {
      get().openView(id);
      return;
    }
    const nextTabs = tabs.some((v) => v.id === id) ? tabs : [...tabs, node];
    if (id === currentViewId) {
      // 想让当前页去右侧：把另一个标签提上来当主视图；只有这一个视图则不做
      const other = nextTabs.find((v) => v.id !== id);
      if (!other) return;
      set({ tabs: nextTabs, currentViewId: other.id, splitViewId: id, route: "workspace" });
    } else {
      set({ tabs: nextTabs, splitViewId: id, route: "workspace" });
    }
    persistNow(get);
    void viewApi.touchVisited(id).catch(logger.catch("WorkspaceStore.openInSplit", "touchVisited failed", id));
  },

  closeSplit: () => {
    set({ splitViewId: null });
    persistNow(get);
  },

  swapSplit: () => {
    const { currentViewId, splitViewId } = get();
    if (!currentViewId || !splitViewId) return;
    set({ currentViewId: splitViewId, splitViewId: currentViewId });
    persistNow(get);
  },

  setSplitRatio: (r) => set({ splitRatio: Math.min(0.75, Math.max(0.25, r)) }),

  newTab: async () => {
    await get().createView({ parentId: null, layout: "document" });
  },

  openDailyNote: async (date) => {
    // 串行排队：并发触发（连点、多入口同时调）会各自查/建一遍目录页，撞出重复目录
    const start = dailyNoteQueue;
    let release!: () => void;
    dailyNoteQueue = new Promise<void>((resolve) => (release = resolve));
    await start;
    try {
      const ws = get().currentWorkspaceId;
      if (!ws) return;
      const lang = useSettingsStore.getState().lang;
      const cfg = loadDailyNotesConfig();
      const dateKey = toDateKey(date ?? new Date());
      // 目录按 年/月 分级：<目录页>/<YYYY>/<MM>/<YYYY-MM-DD>，全部是普通文档页，
      // 无需额外标记：搜索/标签/导出/备份/同步一律按普通页面生效
      const views = await viewApi.listByWorkspace(ws);

      const ensureFolder = async (parentId: string | null, name: string, intro = ""): Promise<View> => {
        const existing = views.find((v) => v.parent_id === parentId && v.layout === "document" && v.name === name);
        if (existing) return existing;
        const created = await viewApi.create({ workspace_id: ws, parent_id: parentId, name, layout: "document" });
        views.push(created);
        try {
          await documentApi.save(created.id, JSON.stringify(buildDailyFolderDoc(name, intro)));
        } catch (e) {
          logger.warn("WorkspaceStore.openDailyNote", "seed folder doc failed", created.id, e);
        }
        return created;
      };

      const root = await ensureFolder(null, cfg.folderName, t("daily.folderIntro"));
      const year = await ensureFolder(root.id, dateKey.slice(0, 4));
      const month = await ensureFolder(year.id, dateKey.slice(5, 7));
      let note = views.find(
        (v) => v.parent_id === month.id && v.layout === "document" && dailyNoteNameMatches(v.name, dateKey),
      );
      if (!note) {
        note = await viewApi.create({
          workspace_id: ws,
          parent_id: month.id,
          name: dailyNoteTitle(dateKey, lang),
          layout: "document",
        });
        views.push(note);
        try {
          await documentApi.save(note.id, JSON.stringify(buildDailyNoteDoc(dateKey, cfg.template, lang)));
        } catch (e) {
          logger.warn("WorkspaceStore.openDailyNote", "seed note doc failed", note.id, e);
        }
      }
      const noteId = note.id;
      await get().reload();
      syncSubpages(get, root.id);
      syncSubpages(get, year.id);
      syncSubpages(get, month.id);
      const expanded = new Set(get().expanded);
      expanded.add(root.id);
      expanded.add(year.id);
      expanded.add(month.id);
      set({ expanded });
      persistNow(get);
      get().openView(noteId);
    } finally {
      release();
    }
  },

  reorderTabs: (fromIndex: number, toIndex: number) => {
    const tabs = [...get().tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    set({ tabs });
    persistNow(get);
  },
});
