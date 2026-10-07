import type { StateCreator, StoreApi } from "zustand";
import type { LayoutType, View, ViewNode, Workspace } from "@/types/models";
import type { TagColorMap } from "@/lib/tags";

export type Route = "workspace" | "trash" | "search" | "settings";

export interface WorkspaceState {
  ready: boolean;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  tree: ViewNode[];
  trash: View[];
  tabs: View[]; // 当前空间打开的标签页（含顺序）
  currentViewId: string | null;
  /** 并排对照：右侧副视图 id（null = 未拆分）；主视图仍是 currentViewId */
  splitViewId: string | null;
  /** 并排左右宽度比例：左栏占比（0.25~0.75） */
  splitRatio: number;
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
  /** 复制页面整棵子树（子页面、正文、属性、数据库数据），副本排在同级末尾并自动打开 */
  duplicateView: (id: string) => Promise<void>;
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

  /** 标签颜色表（全局，跨空间共用；未配置的标签用稳定默认色） */
  tagMeta: TagColorMap;
  loadTagMeta: () => Promise<void>;
  /** 设置标签颜色 */
  setTagColor: (tag: string, color: string) => Promise<void>;
  /** 全局重命名标签：更新所有带该标签的页面与颜色表 */
  renameTag: (from: string, to: string) => Promise<void>;
  /** 全局删除标签：从所有页面移除并清掉颜色配置 */
  deleteTag: (tag: string) => Promise<void>;

  openView: (id: string) => void;
  closeTab: (id: string) => void;
  /** 关闭所有标签页 */
  closeAllTabs: () => void;
  /** 关闭除指定标签外的其它标签页（保留的标签置为当前页） */
  closeOtherTabs: (id: string) => void;
  /** 在右侧分栏打开（并排对照）；已在并排时替换右侧 */
  openInSplit: (id: string) => void;
  closeSplit: () => void;
  /** 左右两栏互换 */
  swapSplit: () => void;
  setSplitRatio: (r: number) => void;
  newTab: () => Promise<void>;
  /** 打开某天的每日笔记（不存在则按模板创建）；date 省略 = 今天 */
  openDailyNote: (date?: Date) => Promise<void>;
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

export type EqualityFn<T> = (a: T, b: T) => boolean;

/**
 * 扩展版 hook 类型：zustand v5 默认删除了第二参数（equalityFn）重载，
 * 项目沿用 v4 风格，这里显式声明三个调用重载 + StoreApi 静态方法，
 * 保证 selector 内 `s` 的 WorkspaceState 类型推断正常。
 */
export interface UseWorkspaceStoreHook {
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

/** 单个 slice 的创建器：与主 store 共享同一份 set/get/api */
export type WorkspaceSliceCreator<T> = StateCreator<WorkspaceState, [], [], T>;

/** 由 StateCreator 暴露的 set/get，供跨 slice 的内部 helper 复用 */
export type WorkspaceSet = StoreApi<WorkspaceState>["setState"];
export type WorkspaceGet = StoreApi<WorkspaceState>["getState"];
