import { useMemo, useState } from "react";
import { Star, X } from "lucide-react";
import type { ViewNode } from "@/types/models";
import { parseViewTags } from "@/types/models";
import { PageTreeItem, type DropHint } from "./PageTreeItem";
import { useWorkspaceStore } from "@/stores/workspace";
import { dropTarget, filterTreeByTag, flattenTree, type DropZone } from "@/lib/tree";
import { t } from "@/lib/i18n";
import { toast } from "sonner";

/** 页面树：递归渲染 + 原生 HTML5 拖拽（排序/换父级），空白处拖放 = 移到根级末尾。
 *  顶部含收藏区（跨目录快速入口）与标签过滤行（点击按标签过滤树）。 */
export function PageTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const moveView = useWorkspaceStore((s) => s.moveView);
  const openView = useWorkspaceStore((s) => s.openView);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  const favorites = useMemo(() => flattenTree(tree).filter((v) => v.is_favorite === 1), [tree]);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const v of flattenTree(tree)) for (const tag of parseViewTags(v.tags)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tree]);

  const displayTree = useMemo(() => (tagFilter ? filterTreeByTag(tree, tagFilter) : tree), [tree, tagFilter]);

  const onMoveFail = (e: unknown) => {
    console.error("move view failed", e);
    toast.error(t("error.db", { message: String(e) }));
  };

  const handleDrop = async (viewId: string, targetId: string, zone: DropZone) => {
    const target = dropTarget(tree, targetId, zone);
    if (!target) return;
    try {
      await moveView(viewId, target.parentId, target.index);
    } catch (e: unknown) {
      onMoveFail(e);
    }
  };

  const handleRootDrop = async (e: React.DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    const from = draggingId;
    setDraggingId(null);
    setDropHint(null);
    try {
      await moveView(from, null, tree.length);
    } catch (e: unknown) {
      onMoveFail(e);
    }
  };

  return (
    <div
      className="flex-1 overflow-y-auto px-2 pb-2"
      onDragOver={(e) => {
        if (draggingId) {
          e.preventDefault();
          if (dropHint) setDropHint(null); // 移出行的区域时清除落点提示
        }
      }}
      onDrop={handleRootDrop}
    >
      {/* 收藏区：有收藏页面时显示，点击直达（保留在树中原位置） */}
      {favorites.length > 0 && (
        <div className="mb-2 border-b border-neutral-200 pb-2">
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
            {t("tree.favorites")}
          </div>
          {favorites.map((v) => (
            <button
              key={v.id}
              className="flex h-[28px] w-full items-center gap-1.5 rounded px-1 text-left hover:bg-neutral-300/40"
              onClick={() => openView(v.id)}
            >
              <Star className="h-3 w-3 shrink-0 fill-brand-500 text-brand-500" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700">{v.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* 标签过滤行：点击标签过滤树，再次点击取消 */}
      {allTags.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {allTags.map((tag) => {
            const on = tagFilter === tag;
            return (
              <button
                key={tag}
                className={
                  "flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] transition " +
                  (on
                    ? "border-brand-500 bg-brand-100 text-brand-700"
                    : "border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-700")
                }
                onClick={() => setTagFilter(on ? null : tag)}
              >
                {tag}
                {on && <X className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}

      {displayTree.length === 0 && (
        <div className="px-2 py-3 text-center text-xs text-neutral-500">
          {tagFilter ? t("tree.noTagMatch") : t("tree.empty")}
        </div>
      )}
      {displayTree.map((node: ViewNode) => (
        <PageTreeItem
          key={node.id}
          node={node}
          depth={0}
          draggingId={draggingId}
          dropHint={dropHint}
          onDraggingChange={(id) => {
            setDraggingId(id);
            if (!id) setDropHint(null);
          }}
          onDropHint={setDropHint}
          onDrop={handleDrop}
        />
      ))}
      {draggingId && !dropHint && <div className="mx-1 my-1 h-[2px] rounded bg-brand-500" />}
    </div>
  );
}
