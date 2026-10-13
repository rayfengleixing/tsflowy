import { create } from "zustand";
import { databaseApi } from "@/lib/database";
import type { RelationDb } from "@/lib/relation";
import { logger } from "@/lib/logger";

// 关联字段的目标库缓存：按目标视图 id 存 fields/rows/cells 快照。
// 关联列要渲染对端行标题、rollup 要对对端行做聚合，两者都需要目标库数据；
// 缓存放在全局 store 里，表格 / 行详情 / 字段设置弹窗共用同一份。
// 快照不再是"首次打开后永不过期"：任何库的字段/行/单元格变化都要 invalidate 对应条目，
// revision 递增会驱动已挂载的 useRelationDbs 重新拉取（对端改动实时反映）。

interface RelationState {
  /** 目标视图 id → 目标库快照 */
  data: Record<string, RelationDb>;
  /** 失效代数：invalidate 递增它，作为消费方 effect 的依赖触发重拉 */
  revision: number;
  /** 拉取目标库快照（已缓存/正在拉取的跳过，多个消费方指向同一目标库只发一次 IPC） */
  ensure: (viewIds: string[]) => void;
  /** 丢弃目标库快照（不传 viewIds = 全部丢弃），并递增 revision 让消费方重新 ensure */
  invalidate: (viewIds?: string[]) => void;
}

// 同一目标库的并发请求去重：多个关联列指向同一目标库时只发一次 IPC
const inflight = new Set<string>();

export const useRelationStore = create<RelationState>()((set, get) => ({
  data: {},
  revision: 0,

  ensure: (viewIds) => {
    for (const viewId of viewIds) {
      if (!viewId || inflight.has(viewId) || viewId in get().data) continue;
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

  invalidate: (viewIds) =>
    set((s) => ({
      data: viewIds ? Object.fromEntries(Object.entries(s.data).filter(([id]) => !viewIds.includes(id))) : {},
      revision: s.revision + 1,
    })),
}));
