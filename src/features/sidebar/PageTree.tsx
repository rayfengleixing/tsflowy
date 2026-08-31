import { useState } from "react";
import type { ViewNode } from "@/types/models";
import { PageTreeItem, type DropHint } from "./PageTreeItem";
import { useWorkspaceStore } from "@/stores/workspace";
import { dropTarget, type DropZone } from "@/lib/tree";
import { t } from "@/lib/i18n";

/** 页面树：递归渲染 + 原生 HTML5 拖拽（排序/换父级），空白处拖放 = 移到根级末尾 */
export function PageTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const moveView = useWorkspaceStore((s) => s.moveView);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  const handleDrop = async (viewId: string, targetId: string, zone: DropZone) => {
    const target = dropTarget(tree, targetId, zone);
    if (!target) return;
    try {
      await moveView(viewId, target.parentId, target.index);
    } catch (e) {
      console.error("move view failed", e);
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
    } catch (e) {
      console.error("move view to root failed", e);
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
      {tree.length === 0 && (
        <div className="px-2 py-3 text-center text-xs text-neutral-500">{t("tree.empty")}</div>
      )}
      {tree.map((node: ViewNode) => (
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
      {draggingId && !dropHint && (
        <div className="mx-1 my-1 h-[2px] rounded bg-brand-500" />
      )}
    </div>
  );
}
