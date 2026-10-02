import { create } from "zustand";
import { databaseApi } from "@/lib/database";
import type { RelationDb } from "@/lib/relation";
import { logger } from "@/lib/logger";

// 关联字段的目标库缓存：按目标视图 id 存 fields/rows/cells 快照。
// 关联列要渲染对端行标题、rollup 要对对端行做聚合，两者都需要目标库数据；
// 缓存放在全局 store 里，表格 / 行详情 / 字段设置弹窗共用同一份。
// 只在目标 id 集合变化时重新拉取，因此同一会话里对目标库的改动要等下次进入才反映。

interface RelationState {
  /** 目标视图 id → 目标库快照 */
  data: Record<string, RelationDb>;
  /** 拉取目标库快照（同一目标库正在拉取时跳过，避免并发重复请求） */
  ensure: (viewIds: string[]) => void;
}

// 同一目标库的并发请求去重：多个关联列指向同一目标库时只发一次 IPC
const inflight = new Set<string>();

export const useRelationStore = create<RelationState>()((set, get) => ({
  data: {},

  ensure: (viewIds) => {
    for (const viewId of viewIds) {
      if (!viewId || inflight.has(viewId)) continue;
      inflight.add(viewId);
      void (async () => {
        try {
          const [fields, rows, cells] = await Promise.all([
            databaseApi.listFields(viewId),
            databaseApi.listRows(viewId),
            databaseApi.loadCells(viewId),
          ]);
          set({ data: { ...get().data, [viewId]: { fields, rows, cells } } });
        } catch (e) {
          // 目标库可能已被删除：不弹错提示，关联列降级显示为空
          logger.error("relation.ensure", e);
        } finally {
          inflight.delete(viewId);
        }
      })();
    }
  },
}));
