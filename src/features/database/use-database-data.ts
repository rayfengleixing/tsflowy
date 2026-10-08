import { useCallback, useEffect, useMemo } from "react";
import { relationTarget, reverseRelationConfig, type RelationDb } from "@/lib/relation";
import { useRelationStore } from "@/stores/relation";
import type { DatabaseField } from "@/types/database";

/**
 * 关联/汇总/反向关系要读别的库：把本表所有关联字段的目标视图、以及反向关系字段的来源视图
 * 拉进缓存（同一视图只请求一次），返回「viewId → 库数据」的解析函数。
 * 对应库未加载时返回 undefined，由调用方降级到原始 id。
 *
 * GridView 与 BoardView 共用（原本各自实现了一份完全相同的代码）。
 */
export function useRelationDbs(fields: DatabaseField[]): (viewId: string) => RelationDb | undefined {
  const relatedViewIds = useMemo(
    () => [
      ...new Set([
        ...fields
          .filter((f) => f.field_type === "relation")
          .map((f) => relationTarget(f))
          .filter((id): id is string => Boolean(id)),
        ...fields
          .filter((f) => f.field_type === "reverse_relation")
          .map((f) => reverseRelationConfig(f)?.source_view_id ?? null)
          .filter((id): id is string => Boolean(id)),
      ]),
    ],
    [fields],
  );
  const relationData = useRelationStore((s) => s.data);
  const ensureRelationDbs = useRelationStore((s) => s.ensure);
  useEffect(() => {
    if (relatedViewIds.length > 0) ensureRelationDbs(relatedViewIds);
  }, [relatedViewIds, ensureRelationDbs]);
  // 行 id → 显示标题；对应库未加载时返回 null，由调用方降级到原始 id
  return useCallback((viewId: string) => relationData[viewId], [relationData]);
}
