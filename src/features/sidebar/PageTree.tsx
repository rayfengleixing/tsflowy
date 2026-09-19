import { useEffect, useMemo, useRef, useState } from "react";
import { Star, X } from "lucide-react";
import type { ViewNode } from "@/types/models";
import { parseViewTags } from "@/types/models";
import { PageTreeItem, type DropHint } from "./PageTreeItem";
import { useWorkspaceStore } from "@/stores/workspace";
import { dropTarget, filterTreeByTag, flattenTree, isDescendant, type DropZone } from "@/lib/tree";
import { t } from "@/lib/i18n";
import { toast } from "sonner";

/** 页面树：递归渲染 + 鼠标事件链拖拽（HTML5 drag 在 WebView2 下不可靠，与编辑器块拖拽同方案）。
 *  顶部含收藏区（跨目录快速入口）与标签过滤行（点击按标签过滤树）。 */
export function PageTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const moveView = useWorkspaceStore((s) => s.moveView);
  const openView = useWorkspaceStore((s) => s.openView);
  const expand = useWorkspaceStore((s) => s.expand);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 拖拽会话（mousedown 记录 → mousemove 超阈值进入拖拽 → mouseup 落点） */
  const sessionRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  /** 拖拽落点后的同帧 click 抑制 */
  const suppressClickRef = useRef(false);

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

  useEffect(() => {
    const zoneForEl = (row: HTMLElement, clientY: number): DropZone => {
      const rect = row.getBoundingClientRect();
      const ratio = (clientY - rect.top) / rect.height;
      return ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
    };
    const rowAt = (el: EventTarget | null): HTMLElement | null => {
      if (!(el instanceof HTMLElement)) return null;
      return el.closest("[data-tree-row]");
    };

    const onMouseMove = (e: MouseEvent) => {
      const s = sessionRef.current;
      if (!s) return;
      if (!s.moved) {
        // 5px 阈值内视为点击（不进入拖拽）
        if (Math.abs(e.clientX - s.startX) + Math.abs(e.clientY - s.startY) < 5) return;
        s.moved = true;
        setDraggingId(s.id);
      }
      const row = rowAt(e.target);
      if (!row?.dataset.treeRow) {
        setDropHint(null);
        return;
      }
      const targetId = row.dataset.treeRow;
      const cur = useWorkspaceStore.getState().tree;
      if (targetId === s.id || isDescendant(cur, targetId, s.id)) {
        setDropHint(null);
        return;
      }
      const zone = zoneForEl(row, e.clientY);
      setDropHint((prev) => (prev?.targetId === targetId && prev.zone === zone ? prev : { targetId, zone }));
    };

    const onMouseUp = (e: MouseEvent) => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (!s) return;
      if (!s.moved) return; // 未拖动：交给行 onClick 打开页面
      suppressClickRef.current = true;
      setTimeout(() => (suppressClickRef.current = false));
      const row = rowAt(e.target);
      const cur = useWorkspaceStore.getState().tree;
      if (row?.dataset.treeRow) {
        const targetId = row.dataset.treeRow;
        if (targetId !== s.id && !isDescendant(cur, targetId, s.id)) {
          const zone = zoneForEl(row, e.clientY);
          if (zone === "inside") expand(targetId);
          void handleDrop(s.id, targetId, zone);
        }
      } else if (containerRef.current?.contains(e.target as Node)) {
        // 树容器空白处落点 → 移到根级末尾
        void moveView(s.id, null, cur.length).catch(onMoveFail);
      }
      setDraggingId(null);
      setDropHint(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, expand]);

  /** 行点击（会话未变成拖拽时打开页面） */
  const onRowClick = (id: string) => {
    if (suppressClickRef.current) return;
    openView(id);
  };

  /** 行 mousedown：左键且不在交互控件上时启动潜在拖拽会话 */
  const onRowMouseDown = (id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, a, [role=button]")) return;
    e.preventDefault(); // 防止拖拽选中文本
    sessionRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
  };

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-2 pb-2">
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
          onRowMouseDown={onRowMouseDown}
          onRowClick={onRowClick}
        />
      ))}
      {draggingId && !dropHint && <div className="mx-1 my-1 h-[2px] rounded bg-brand-500" />}
    </div>
  );
}
