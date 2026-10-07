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
import { persistNow } from "./persistence";
import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

/** 每日笔记打开串行队列：并发触发（连点、多入口同时调）会各自走一遍「查或建目录」，撞出重复目录页 */
let dailyNoteQueue: Promise<void> = Promise.resolve();

export const createTabsSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  tabs: [],
  currentViewId: null,
  splitViewId: null,
  splitRatio: 0.5,

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
      set({ tabs: nextTabs, currentViewId: id, route: "workspace" });
      persistNow(get);
    } else {
      set({ route: "workspace" });
    }
    // Phase 3.2：异步刷新 visited_at，不阻塞 UI（失败仅 warn，不影响打开流程）
    void viewApi.touchVisited(id).catch(logger.catch("WorkspaceStore.openView", "touchVisited failed", id));
  },

  closeTab: (id: string) => {
    const tabs = get().tabs.filter((v) => v.id !== id);
    let currentViewId = get().currentViewId;
    if (currentViewId === id) {
      const idx = get().tabs.findIndex((v) => v.id === id);
      currentViewId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    }
    // 关掉的是副视图则取消并排
    const splitViewId = get().splitViewId === id ? null : get().splitViewId;
    set({ tabs, currentViewId, splitViewId });
    persistNow(get);
  },

  closeAllTabs: () => {
    set({ tabs: [], currentViewId: null, splitViewId: null });
    persistNow(get);
  },

  closeOtherTabs: (id) => {
    const keep = get().tabs.find((v) => v.id === id);
    if (!keep) return;
    // 保留的标签可能是右栏（副视图）：收敛为唯一标签并置为当前页
    set({ tabs: [keep], currentViewId: id, splitViewId: null });
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

  closeSplit: () => set({ splitViewId: null }),

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
      // （listByWorkspace 已排除行详情文档与派生视图，返回的都是树里的页面）
      const views = await viewApi.listByWorkspace(ws);

      // 找/建同名文档子页；新建时 seed 成「H1 + 分割线」的目录页文档（结构锁定要求首行 H1）
      const ensureFolder = async (parentId: string | null, name: string, intro = ""): Promise<View> => {
        const existing = views.find((v) => v.parent_id === parentId && v.layout === "document" && v.name === name);
        if (existing) return existing;
        const created = await viewApi.create({ workspace_id: ws, parent_id: parentId, name, layout: "document" });
        views.push(created);
        try {
          await documentApi.save(created.id, JSON.stringify(buildDailyFolderDoc(name, intro)));
        } catch (e) {
          // 正文种子失败不阻断：页面已建好，用户可直接写
          logger.warn("WorkspaceStore.openDailyNote", "seed folder doc failed", created.id, e);
        }
        return created;
      };

      const root = await ensureFolder(null, cfg.folderName, t("daily.folderIntro"));
      const year = await ensureFolder(root.id, dateKey.slice(0, 4));
      const month = await ensureFolder(year.id, dateKey.slice(5, 7));
      // 页面名形如「10-02 周五」：用「月-日」前缀 + 边界匹配，可跨语言切换复用同一天笔记
      // （旧命名 YYYY-MM-DD 前缀是年份不会命中；"10-025" 这类更长数字也不会误匹配）
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
      // 目录页与普通文档一样带「子页面」双链列表：每日笔记页列年份、年份页列月份、月份页列当月笔记。
      // 每次都按最新页面树整体重写，所以历史遗留的目录页也会被补齐。
      syncSubpages(get, root.id);
      syncSubpages(get, year.id);
      syncSubpages(get, month.id);
      // 展开要在同步之后：目录页若正开着，先就地改编辑器再打开笔记，避免卸载时把新列表覆盖掉
      // 逐级展开，保证当天笔记在树里可见
      const expanded = new Set(get().expanded);
      expanded.add(root.id);
      expanded.add(year.id);
      expanded.add(month.id);
      set({ expanded });
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
