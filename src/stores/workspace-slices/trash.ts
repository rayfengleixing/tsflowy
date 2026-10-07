import { viewApi } from "@/lib/db";
import { syncSubpages } from "./tree";
import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

export const createTrashSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (_set, get) => ({
  trash: [],

  purgeTrash: async () => {
    const ws = get().currentWorkspaceId;
    if (!ws) return;
    // 被永久删除的页面，其"未被删除的父页"子页面块需要刷新（回收站列表 reload 后即清空）
    const trashedIds = new Set(get().trash.map((v) => v.id));
    const affectedParents = new Set<string>();
    for (const v of get().trash) {
      if (v.parent_id && !trashedIds.has(v.parent_id)) affectedParents.add(v.parent_id);
    }
    await viewApi.purgeTrash(ws);
    await get().reload();
    for (const pid of affectedParents) syncSubpages(get, pid);
  },
});
