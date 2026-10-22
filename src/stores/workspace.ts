import { create } from "zustand";
import { bindAppActions, bindAppReaders } from "@/lib/app-context";
import type { UseWorkspaceStoreHook, WorkspaceState } from "./workspace-slices/types";
import { createWorkspacesSlice } from "./workspace-slices/workspaces";
import { createTreeSlice } from "./workspace-slices/tree";
import { createTrashSlice } from "./workspace-slices/trash";
import { createTabsSlice } from "./workspace-slices/tabs";
import { createRoutingSlice } from "./workspace-slices/routing";
import { createUiSlice } from "./workspace-slices/ui";
import { createTagsSlice } from "./workspace-slices/tags";

// 组合各 slice（zustand slices 模式）：每个 slice 只负责一块职责，
// 共享同一份 WorkspaceState 类型与 set/get，组合后对外仍是单一 store。
const _useWorkspaceStore = create<WorkspaceState>()(
  (...a) =>
    ({
      ...createWorkspacesSlice(...a),
      ...createTreeSlice(...a),
      ...createTrashSlice(...a),
      ...createTabsSlice(...a),
      ...createRoutingSlice(...a),
      ...createUiSlice(...a),
      ...createTagsSlice(...a),
    }) as WorkspaceState,
) as unknown as UseWorkspaceStoreHook;

export const useWorkspaceStore = _useWorkspaceStore;

// 页面树、当前空间与当前页的读取，加上刷树/改名/开页/切界面/订阅这几个写动作交给 lib/app-context
// （导出整目录、AI 写动作、深链跳转、更新与巡检提示在 lib 侧要用，而 lib 不该反向依赖 store）。
// 绑的是取值函数/动作函数而非快照：store 重新加载页面树后 lib 侧自然读到新值。
bindAppReaders({
  getTree: () => useWorkspaceStore.getState().tree,
  getCurrentWorkspaceId: () => useWorkspaceStore.getState().currentWorkspaceId,
  getCurrentViewId: () => useWorkspaceStore.getState().currentViewId,
});
bindAppActions({
  reload: () => useWorkspaceStore.getState().reload(),
  renameView: (viewId, name) => useWorkspaceStore.getState().renameView(viewId, name),
  openView: (viewId) => useWorkspaceStore.getState().openView(viewId),
  setRoute: (route) => useWorkspaceStore.getState().setRoute(route),
  subscribeWorkspace: (listener) => useWorkspaceStore.subscribe(listener),
});

export type { Route, WorkspaceState } from "./workspace-slices/types";
export { flushPendingUiPersist } from "./workspace-slices/persistence";
export { findInTree } from "./workspace-slices/tree";
