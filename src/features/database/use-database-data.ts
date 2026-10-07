import { useCallback, useEffect, useMemo } from "react";
import { relationTarget, type RelationDb } from "@/lib/relation";
import { useRelationStore } from "@/stores/relation";
import type { DatabaseField } from "@/types/database";

/**
 * 关联/汇总要读目标库：把本表所有关联字段的目标视图拉进缓存（同一目标库只请求一次），
 * 返回「目标 viewId → 目标库数据」的解析函数。
 * 目标库未加载时返回 undefined，由调用方降级到原始 id。
 *
 * GridView 与 BoardView 共用（原本各自实现了一份完全相同的代码）。
 */
export function useRelationDbs(fields: DatabaseField[]): (viewId: string) => RelationDb | undefined {
  const relationTargetIds = useMemo(
    () => [
      ...new Set(
        fields
          .filter((f) => f.field_type === "relation")
          .map((f) => relationTarget(f))
          .filter((id): id is string => Boolean(id)),
      ),
    ],
    [fields],
  );
  const relationData = useRelationStore((s) => s.data);
  const ensureRelationDbs = useRelationStore((s) => s.ensure);
  useEffect(() => {
    if (relationTargetIds.length > 0) ensureRelationDbs(relationTargetIds);
  }, [relationTargetIds, ensureRelationDbs]);
  // 目标行 id → 显示标题；目标库未加载时返回 null，由调用方降级到原始 id
  return useCallback((viewId: string) => relationData[viewId], [relationData]);
}
