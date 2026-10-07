import { create } from "zustand";
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

export type { Route, WorkspaceState } from "./workspace-slices/types";
export { flushPendingUiPersist } from "./workspace-slices/persistence";
export { findInTree } from "./workspace-slices/tree";
