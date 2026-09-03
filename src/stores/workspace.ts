import { create } from "zustand";
import type { LayoutType, View, ViewNode, Workspace } from "@/types/models";
import { viewApi, workspaceApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { newSelectOption } from "@/lib/database-values";
import { buildTree, flattenTree } from "@/lib/tree";
import { useSettingsStore } from "./settings";

export type Route = "workspace" | "trash" | "search" | "settings";

interface WorkspaceState {
  ready: boolean;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  tree: ViewNode[];
  favorites: View[];
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
  toggleFavorite: (id: string) => Promise<void>;
  deleteView: (id: string) => Promise<void>;
  restoreView: (id: string) => Promise<void>;
  purgeView: (id: string) => Promise<void>;
  purgeTrash: () => Promise<void>;
  moveView: (viewId: string, newParentId: string | null, index: number) => Promise<void>;

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

const purgeAllExpiredTrash = async (): Promise<void> => {
  const workspaces = useWorkspaceStore.getState().workspaces;
  if (workspaces.length === 0) return;
  const now = Date.now();
  const deadline = now - THIRTY_DAYS_MS;
  for (const ws of workspaces) {
    try {
      await viewApi.purgeExpiredTrash(ws.id, deadline);
    } catch (e) {
      console.error("auto purge expired trash failed", ws.id, e);
    }
  }
  // 如果当前 workspace 的 trash 列表在 store，重新 reload 刷新 UI
  const ws = useWorkspaceStore.getState().currentWorkspaceId;
  if (ws) await useWorkspaceStore.getState().reload();
};

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const patchTree = async (): Promise<void> => {
    const { currentWorkspaceId } = get();
    if (!currentWorkspaceId) return;
    const [views, favorites, trash] = await Promise.all([
      viewApi.listByWorkspace(currentWorkspaceId),
      viewApi.listFavorites(currentWorkspaceId),
      viewApi.listTrash(currentWorkspaceId),
    ]);
    const tree = buildTree(views);
    set({
      tree,
      favorites,
      trash,
      tabs: get().tabs.filter((v) => v.workspace_id === currentWorkspaceId),
    });
  };

  return {
    ready: false,
    workspaces: [],
    currentWorkspaceId: null,
    tree: [],
    favorites: [],
    trash: [],
    tabs: [],
    currentViewId: null,
    route: "workspace",
    searchQuery: "",
    paletteOpen: false,
    expanded: new Set<string>(),
    sidebarWidth: 240,

    init: async () => {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          let workspaces = await workspaceApi.list();
          if (workspaces.length === 0) {
            // 首次启动种子数据：默认空间 + 欢迎文档
            const lang = useSettingsStore.getState().lang;
            const wsName = lang === "zh-CN" ? "我的工作区" : "My Workspace";
            const ws = await workspaceApi.create(wsName);
            const welcome = await viewApi.create({
              workspace_id: ws.id,
              parent_id: null,
              name: lang === "zh-CN" ? "欢迎使用 AppFlowy TS" : "Welcome to AppFlowy TS",
              layout: "document",
            });
            void welcome;
            workspaces = await workspaceApi.list();
          }
          let current = await viewApi.getSetting("last_workspace_id");
          if (!current || !workspaces.some((w) => w.id === current)) {
            current = workspaces[0].id;
          }
          set({ workspaces, currentWorkspaceId: current, ready: true });
          await get().reload();
          // 首次启动展开根级页面
          set({ expanded: new Set(get().tree.filter((n) => n.children.length > 0).map((n) => n.id)) });
          // 30 天回收站自动清空：启动立即扫一次，然后每小时轮询
          if (autoPurgeTimer === null) {
            void purgeAllExpiredTrash();
            autoPurgeTimer = setInterval(() => {
              void purgeAllExpiredTrash();
            }, HOURLY_MS);
          }
        } catch (e) {
          console.error("workspace init failed", e);
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
      set({ currentWorkspaceId: id, tabs: [], currentViewId: null });
      await viewApi.setSetting("last_workspace_id", id);
      await get().reload();
      // 展开新空间根级页面
      set({ expanded: new Set(get().tree.filter((n) => n.children.length > 0).map((n) => n.id)) });
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
          console.error("seed grid fields failed", view.id, e);
        }
      }
      await get().reload();
      set({ expanded: new Set(get().expanded).add(parentId ?? "") });
      get().openView(view.id);
      return view;
    },

    renameView: async (id: string, name: string) => {
      await viewApi.rename(id, name);
      set({
        tabs: get().tabs.map((v) => (v.id === id ? { ...v, name } : v)),
      });
      await get().reload();
    },

    setViewIcon: async (id: string, icon: string | null) => {
      await viewApi.setIcon(id, icon);
      set({
        tabs: get().tabs.map((v) => (v.id === id ? { ...v, icon } : v)),
      });
      await get().reload();
    },

    toggleFavorite: async (id: string) => {
      const node = get().tree.find((n) => n.id === id) ?? null;
      const favorite = node ? node.is_favorite === 1 : false;
      await viewApi.setFavorite(id, !favorite);
      await get().reload();
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
      if (!tabs.some((v) => v.id === id)) {
        set({ tabs: [...tabs, node] });
      }
      set({ currentViewId: id, route: "workspace" });
    },

    closeTab: (id: string) => {
      const tabs = get().tabs.filter((v) => v.id !== id);
      let currentViewId = get().currentViewId;
      if (currentViewId === id) {
        const idx = get().tabs.findIndex((v) => v.id === id);
        currentViewId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      set({ tabs, currentViewId });
    },

    newTab: async () => {
      await get().createView({ parentId: null, layout: "document" });
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      const tabs = [...get().tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      set({ tabs });
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

    setSidebarWidth: (w: number) => set({ sidebarWidth: w }),
  };
});

/** Grid 默认字段 + 空行（名称/数字/单选；单选预置两个选项） */
async function seedGridFields(viewId: string, lang: "zh-CN" | "en-US"): Promise<void> {
  const text = await databaseApi.createField(viewId, "text", lang === "zh-CN" ? "名称" : "Name");
  await databaseApi.createField(viewId, "number", lang === "zh-CN" ? "数字" : "Number");
  const select = await databaseApi.createField(viewId, "single_select", lang === "zh-CN" ? "单选" : "Select");
  await databaseApi.updateFieldOptions(select.id, {
    kind: "select",
    options: [newSelectOption("选项 1"), newSelectOption("选项 2")],
  });
  await databaseApi.createRow(viewId);
  void text;
}

function findInTree(nodes: ViewNode[], id: string): ViewNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findInTree(n.children, id);
    if (found) return found;
  }
  return null;
}