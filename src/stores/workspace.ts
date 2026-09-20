import { create } from "zustand";
import type { LayoutType, View, ViewNode, Workspace } from "@/types/models";
import { viewApi, workspaceApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { documentApi } from "@/lib/documents";
import { newSelectOption } from "@/lib/database-values";
import { buildTree, flattenTree } from "@/lib/tree";
import { useSettingsStore } from "./settings";
import { logger } from "@/lib/logger";
import { buildWelcomeDoc, welcomeDocTitle } from "@/lib/welcome-doc";

export type Route = "workspace" | "trash" | "search" | "settings";

interface WorkspaceState {
  ready: boolean;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  tree: ViewNode[];
  trash: View[];
  tabs: View[]; // 当前空间打开的标签页（含顺序）
  currentViewId: string | null;
  route: Route;
  /** 搜索结果页当前查询词 */
  searchQuery: string;
  expanded: Set<string>;
  sidebarWidth: number;

  init: () => Promise<void>;
  reload: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;

  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  setWorkspaceIcon: (id: string, icon: string | null) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  createView: (opts: { parentId: string | null; layout: LayoutType }) => Promise<View | null>;
  renameView: (id: string, name: string) => Promise<void>;
  setViewIcon: (id: string, icon: string | null) => Promise<void>;
  /** 收藏/取消收藏（侧边栏收藏区） */
  setViewFavorite: (id: string, favorite: boolean) => Promise<void>;
  /** 设置页面标签（整体覆写） */
  setViewTags: (id: string, tags: string[]) => Promise<void>;
  deleteView: (id: string) => Promise<void>;
  restoreView: (id: string) => Promise<void>;
  purgeView: (id: string) => Promise<void>;
  purgeTrash: () => Promise<void>;
  moveView: (viewId: string, newParentId: string | null, index: number) => Promise<void>;

  /** 页面树标签过滤：null = 不过滤 */
  tagFilter: string | null;
  setTagFilter: (tag: string | null) => void;

  openView: (id: string) => void;
  closeTab: (id: string) => void;
  newTab: () => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setRoute: (route: Route) => void;
  /** 打开搜索结果页 */
  openSearch: (query: string) => void;
  /** Ctrl+K 命令面板开关 */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  toggleExpand: (id: string) => void;
  expand: (id: string) => void;
  setExpandedAll: (ids: Set<string>) => void;
  setSidebarWidth: (w: number) => void;
}

let initPromise: Promise<void> | null = null;

/** 30 天回收站自动清空定时器：全局只建一次；每小时扫一次，跨空间清理 */
let autoPurgeTimer: ReturnType<typeof setInterval> | null = null;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

const TABS_KEY = (wsId: string) => `ui:tabs:${wsId}`;
const CURRENT_KEY = (wsId: string) => `ui:current_view:${wsId}`;

/** 标签页/当前视图写回 app_settings 的 300ms 去抖（避免每次 closeTab/reorderTabs 写 DB） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPendingWs: string | null = null;
let persistPendingTabs: string[] | null = null;
let persistPendingCurrent: string | null | undefined = undefined; // undefined=未变化；null=清空

function schedulePersistUi(wsId: string, tabIds: string[], currentViewId: string | null) {
  persistPendingWs = wsId;
  persistPendingTabs = tabIds;
  persistPendingCurrent = currentViewId;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const wsId2 = persistPendingWs;
    const tabs2 = persistPendingTabs;
    const cur2 = persistPendingCurrent;
    persistTimer = null;
    persistPendingWs = null;
    persistPendingTabs = null;
    persistPendingCurrent = undefined;
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
  persistPendingWs = null;
  persistPendingTabs = null;
  persistPendingCurrent = undefined;
  if (!wsId || !tabs) return;
  try {
    await viewApi.setSetting(TABS_KEY(wsId), JSON.stringify(tabs));
    if (cur !== undefined) {
      await viewApi.setSetting(CURRENT_KEY(wsId), cur ?? "");
    }
  } catch (e) {
    logger.warn("WorkspaceStore", "flush pending tabs failed", wsId, e);
  }
}

async function loadTabsForWs(wsId: string, tree: ViewNode[]): Promise<{ tabs: View[]; currentViewId: string | null }> {
  try {
    const [tabsRaw, curRaw] = await Promise.all([
      viewApi.getSetting(TABS_KEY(wsId)),
      viewApi.getSetting(CURRENT_KEY(wsId)),
    ]);
    const ids: string[] = tabsRaw ? (JSON.parse(tabsRaw) as string[]) : [];
    const byId = new Map<string, ViewNode>();
    for (const n of flattenTree(tree)) byId.set(n.id, n);
    const tabs = ids.map((i) => byId.get(i)).filter(Boolean) as ViewNode[];
    let currentViewId = curRaw ?? null;
    if (currentViewId && !byId.has(currentViewId)) currentViewId = null;
    // 若持久化中没有 current，但 tabs 有，默认第一个
    if (!currentViewId && tabs.length > 0) currentViewId = tabs[0].id;
    return { tabs, currentViewId };
  } catch (e) {
    logger.warn("WorkspaceStore", "load tabs failed", wsId, e);
    return { tabs: [], currentViewId: null };
  }
}

const purgeAllExpiredTrash = async (): Promise<void> => {
  const workspaces = useWorkspaceStore.getState().workspaces;
  if (workspaces.length === 0) return;
  const now = Date.now();
  const deadline = now - THIRTY_DAYS_MS;
  for (const ws of workspaces) {
    try {
      await viewApi.purgeExpiredTrash(ws.id, deadline);
    } catch (e) {
      logger.error("WorkspaceStore", "auto purge expired trash failed", ws.id, e);
    }
  }
  // 如果当前 workspace 的 trash 列表在 store，重新 reload 刷新 UI
  const ws = useWorkspaceStore.getState().currentWorkspaceId;
  if (ws) await useWorkspaceStore.getState().reload();
};

/** 递归更新树中某个节点的 icon（避免全量 reload，提升响应速度） */
function patchTreeIcon(tree: ViewNode[], id: string, icon: string | null): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, icon };
    if (node.children.length > 0) return { ...node, children: patchTreeIcon(node.children, id, icon) };
    return node;
  });
}

/** 递归更新树中某个节点的 name */
function patchTreeName(tree: ViewNode[], id: string, name: string): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, name };
    if (node.children.length > 0) return { ...node, children: patchTreeName(node.children, id, name) };
    return node;
  });
}

/** 递归更新树中某个节点的部分字段（icon/name/tags/is_favorite 等浅字段） */
function patchTreeView(tree: ViewNode[], id: string, patch: Partial<View>): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, ...patch };
    if (node.children.length > 0) return { ...node, children: patchTreeView(node.children, id, patch) };
    return node;
  });
}

type EqualityFn<T> = (a: T, b: T) => boolean;

/**
 * 扩展版 hook 类型：zustand v5 默认删除了第二参数（equalityFn）重载，
 * 项目沿用 v4 风格，这里显式声明三个调用重载 + StoreApi 静态方法，
 * 保证 selector 内 `s` 的 WorkspaceState 类型推断正常。
 */
interface UseWorkspaceStoreHook {
  (): WorkspaceState;
  <U>(selector: (s: WorkspaceState) => U): U;
  <U>(selector: (s: WorkspaceState) => U, equalityFn: EqualityFn<U>): U;
  getState: () => WorkspaceState;
  getInitialState: () => WorkspaceState;
  setState: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState> | WorkspaceState),
    replace?: boolean,
  ) => void;
  subscribe: (listener: (state: WorkspaceState, prevState: WorkspaceState) => void) => () => void;
}

const _useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  // 把 tabs + current 状态根据 ids 计算并 schedule 持久化（所有状态变更都走这个 helper 统一）
  const persistNow = () => {
    const { currentWorkspaceId, tabs, currentViewId } = get();
    if (!currentWorkspaceId) return;
    schedulePersistUi(
      currentWorkspaceId,
      tabs.map((v) => v.id),
      currentViewId,
    );
  };

  // 树加载是异步的：晚到的响应可能属于已切走的空间（或已被更新的请求），只允许最新一次写入。
  // 没有它时快速切空间/连续刷新会让旧空间的树盖住新空间的树。
  let treeSeq = 0;

  const patchTree = async (): Promise<void> => {
    const { currentWorkspaceId } = get();
    if (!currentWorkspaceId) return;
    const seq = ++treeSeq;
    const [views, trash] = await Promise.all([
      viewApi.listByWorkspace(currentWorkspaceId),
      viewApi.listTrash(currentWorkspaceId),
    ]);
    if (seq !== treeSeq || get().currentWorkspaceId !== currentWorkspaceId) return;
    const tree = buildTree(views);
    // 只保留 tree 中真实存在（未被删/移走）的 tabs，按原顺序
    const byId = new Map<string, ViewNode>();
    for (const n of flattenTree(tree)) byId.set(n.id, n);
    const tabs = get()
      .tabs.map((v) => byId.get(v.id))
      .filter(Boolean) as ViewNode[];
    let currentViewId = get().currentViewId;
    if (currentViewId && !byId.has(currentViewId)) currentViewId = tabs[0]?.id ?? null;
    set({ tree, trash, tabs, currentViewId });
    persistNow();
  };

  // patchTree 的变体：调用 loadTabsForWs 从 app_settings 恢复（首次进入 workspace）
  const patchTreeAndRestoreTabs = async (): Promise<void> => {
    const { currentWorkspaceId } = get();
    if (!currentWorkspaceId) return;
    const seq = ++treeSeq;
    const [views, trash] = await Promise.all([
      viewApi.listByWorkspace(currentWorkspaceId),
      viewApi.listTrash(currentWorkspaceId),
    ]);
    const tree = buildTree(views);
    const { tabs, currentViewId } = await loadTabsForWs(currentWorkspaceId, tree);
    if (seq !== treeSeq || get().currentWorkspaceId !== currentWorkspaceId) return;
    set({ tree, trash, tabs, currentViewId });
    persistNow();
  };

  return {
    ready: false,
    workspaces: [],
    currentWorkspaceId: null,
    tree: [],
    trash: [],
    tabs: [],
    currentViewId: null,
    route: "workspace",
    searchQuery: "",
    paletteOpen: false,
    expanded: new Set<string>(),
    sidebarWidth: 240,
    tagFilter: null,

    init: async () => {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          let workspaces = await workspaceApi.list();
          if (workspaces.length === 0) {
            // 首次启动种子数据：默认空间 + 欢迎文档（内容为全部功能的示例与使用说明）
            const lang = useSettingsStore.getState().lang;
            const wsName = lang === "zh-CN" ? "我的工作区" : "My Workspace";
            const ws = await workspaceApi.create(wsName);
            const welcome = await viewApi.create({
              workspace_id: ws.id,
              parent_id: null,
              name: welcomeDocTitle(lang),
              layout: "document",
            });
            await documentApi.save(welcome.id, JSON.stringify(buildWelcomeDoc(lang)));
            workspaces = await workspaceApi.list();
          }
          let current = await viewApi.getSetting("last_workspace_id");
          if (!current || !workspaces.some((w) => w.id === current)) {
            current = workspaces[0].id;
          }
          set({ workspaces, currentWorkspaceId: current, ready: true });
          await patchTreeAndRestoreTabs();
          // 首次启动展开根级页面
          set({
            expanded: new Set(
              get()
                .tree.filter((n) => n.children.length > 0)
                .map((n) => n.id),
            ),
          });
          // 30 天回收站自动清空：启动立即扫一次，然后每小时轮询
          if (autoPurgeTimer === null) {
            void purgeAllExpiredTrash();
            autoPurgeTimer = setInterval(() => {
              void purgeAllExpiredTrash();
            }, HOURLY_MS);
          }
        } catch (e) {
          logger.error("WorkspaceStore.init", "workspace init failed", e);
          // 修复 App 死循环：init 失败时**由 store 内部**最终保证 ready=true，
          // 避免 App.catch 外部再写一份 setState 引发 zustand selector 重判定触发 React 19 开发模式的快照检查。
          // ready 相同值短路（zustand 默认比较对象是整 state，这里字段本身已 true 时不会额外 emit）。
          if (!get().ready) set({ ready: true });
          throw e;
        }
      })();
      return initPromise;
    },

    reload: async () => {
      await patchTree();
    },

    switchWorkspace: async (id: string) => {
      if (id === get().currentWorkspaceId) return;
      // 切换前立即把旧空间的 tabs 持久化（不等 300ms，避免丢失）
      await flushPendingUiPersist();

      set({ currentWorkspaceId: id, tabs: [], currentViewId: null });
      await viewApi.setSetting("last_workspace_id", id);
      await patchTreeAndRestoreTabs();
      // 展开新空间根级页面
      set({
        expanded: new Set(
          get()
            .tree.filter((n) => n.children.length > 0)
            .map((n) => n.id),
        ),
      });
    },

    createWorkspace: async (name: string) => {
      const ws = await workspaceApi.create(name);
      set({ workspaces: [...get().workspaces, ws] });
    },

    renameWorkspace: async (id: string, name: string) => {
      await workspaceApi.rename(id, name);
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      });
    },

    setWorkspaceIcon: async (id: string, icon: string | null) => {
      await workspaceApi.setIcon(id, icon);
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, icon } : w)),
      });
    },

    deleteWorkspace: async (id: string) => {
      await workspaceApi.remove(id);
      const workspaces = get().workspaces.filter((w) => w.id !== id);
      set({ workspaces });
      if (get().currentWorkspaceId === id) {
        const next = workspaces[0] ?? null;
        set({ currentWorkspaceId: next ? next.id : null, tabs: [], currentViewId: null });
        if (next) {
          await viewApi.setSetting("last_workspace_id", next.id);
          await get().reload();
        }
      }
    },

    createView: async ({ parentId, layout }) => {
      const ws = get().currentWorkspaceId;
      if (!ws) return null;
      const lang = useSettingsStore.getState().lang;
      const name = lang === "zh-CN" ? "无标题页面" : "Untitled";
      const view = await viewApi.create({
        workspace_id: ws,
        parent_id: parentId,
        name,
        layout,
      });
      if (layout === "grid") {
        // Grid 预置默认字段（名称/数字/单选）+ 一个空行（项目说明书 5.1）
        try {
          await seedGridFields(view.id, lang);
        } catch (e) {
          logger.error("WorkspaceStore.createView", "seed grid fields failed", view.id, e);
        }
      }
      await get().reload();
      set({ expanded: new Set(get().expanded).add(parentId ?? "") });
      get().openView(view.id);
      return view;
    },

    renameView: async (id: string, name: string) => {
      await viewApi.rename(id, name);
      set((state) => ({
        tabs: state.tabs.map((v) => (v.id === id ? { ...v, name } : v)),
        tree: patchTreeName(state.tree, id, name),
      }));
    },

    setViewIcon: async (id: string, icon: string | null) => {
      await viewApi.setIcon(id, icon);
      set((state) => ({
        tabs: state.tabs.map((v) => (v.id === id ? { ...v, icon } : v)),
        tree: patchTreeIcon(state.tree, id, icon),
      }));
    },

    setViewFavorite: async (id: string, favorite: boolean) => {
      await viewApi.setFavorite(id, favorite);
      set((state) => ({ tree: patchTreeView(state.tree, id, { is_favorite: favorite ? 1 : 0 }) }));
    },

    setViewTags: async (id: string, tags: string[]) => {
      await viewApi.setTags(id, tags);
      set((state) => ({ tree: patchTreeView(state.tree, id, { tags: JSON.stringify(tags) }) }));
    },

    deleteView: async (id: string) => {
      await viewApi.softDelete(id);
      // 关闭该视图及全部后代的标签页
      const node = findInTree(get().tree, id);
      const affected = node ? new Set(flattenTree([node]).map((n) => n.id)) : new Set([id]);
      const tabs = get().tabs.filter((v) => !affected.has(v.id));
      const current = get().currentViewId;
      const currentViewId = current && affected.has(current) ? (tabs[tabs.length - 1]?.id ?? null) : current;
      set({ tabs, currentViewId });
      await get().reload();
    },

    restoreView: async (id: string) => {
      await viewApi.restore(id);
      await get().reload();
    },

    purgeView: async (id: string) => {
      await viewApi.purge(id);
      await get().reload();
    },

    purgeTrash: async () => {
      const ws = get().currentWorkspaceId;
      if (!ws) return;
      await viewApi.purgeTrash(ws);
      await get().reload();
    },

    moveView: async (viewId, newParentId, index) => {
      await viewApi.move(viewId, newParentId, index);
      await get().reload();
    },

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
        persistNow();
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
      set({ tabs, currentViewId });
      persistNow();
    },

    newTab: async () => {
      await get().createView({ parentId: null, layout: "document" });
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      const tabs = [...get().tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      set({ tabs });
      persistNow();
    },

    setRoute: (route: Route) => set({ route }),

    openSearch: (query: string) => set({ route: "search", searchQuery: query, paletteOpen: false }),

    openPalette: () => set({ paletteOpen: true }),
    closePalette: () => set({ paletteOpen: false }),

    toggleExpand: (id: string) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      set({ expanded });
    },

    expand: (id: string) => {
      if (!get().expanded.has(id)) {
        set({ expanded: new Set(get().expanded).add(id) });
      }
    },

    setExpandedAll: (ids: Set<string>) => set({ expanded: ids }),

    setTagFilter: (tag) => set({ tagFilter: tag }),

    setSidebarWidth: (w: number) => set({ sidebarWidth: w }),
  };
}) as unknown as UseWorkspaceStoreHook;

export const useWorkspaceStore = _useWorkspaceStore;

/** Grid 默认字段 + 空行（名称/日期/单选；单选预置两个选项，日期供日历视图使用，单选供看板视图使用） */
async function seedGridFields(viewId: string, lang: "zh-CN" | "en-US"): Promise<void> {
  await databaseApi.createField(viewId, "text", lang === "zh-CN" ? "名称" : "Name");
  await databaseApi.createField(viewId, "date", lang === "zh-CN" ? "日期" : "Date");
  const select = await databaseApi.createField(viewId, "single_select", lang === "zh-CN" ? "单选" : "Select");
  await databaseApi.updateFieldOptions(select.id, {
    kind: "select",
    options: [newSelectOption("选项 1"), newSelectOption("选项 2")],
  });
  await databaseApi.createRow(viewId);
}

function findInTree(nodes: ViewNode[], id: string): ViewNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findInTree(n.children, id);
    if (found) return found;
  }
  return null;
}
