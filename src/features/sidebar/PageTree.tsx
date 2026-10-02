import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Star, X } from "lucide-react";
import { parseViewTags } from "@/types/models";
import { PageTreeItem, type DropHint } from "./PageTreeItem";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  dropTarget,
  filterTreeByTag,
  flattenTree,
  flattenVisibleTree,
  isDescendant,
  type DropZone,
  type VisibleTreeRow,
} from "@/lib/tree";
import { t } from "@/lib/i18n";
import { tagColor, tagTint } from "@/lib/tags";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

/** 行高（PageTreeItem 的行容器固定 h-[30px]）：窗口化按固定行高换算，无需测量 */
const ROW_H = 30;
/** 窗口化阈值：可见行数超过它才启用（小树保持全量渲染，零行为差异） */
const VIRTUAL_MIN_ROWS = 150;
/** 视口上下各多渲染的行数：抵消快速滚动时的白屏 */
const VIRTUAL_OVERSCAN = 12;

/** 页面树：展平成同级行渲染（跟随展开状态）+ 大列表窗口化。
 *  鼠标事件链拖拽（HTML5 drag 在 WebView2 下不可靠，与编辑器块拖拽同方案），行仍带 data-tree-row。
 *  顶部含收藏区（跨目录快速入口）与标签过滤行（点击按标签过滤树）。 */
export function PageTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const moveView = useWorkspaceStore((s) => s.moveView);
  const openView = useWorkspaceStore((s) => s.openView);
  const expand = useWorkspaceStore((s) => s.expand);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const tagMeta = useWorkspaceStore((s) => s.tagMeta);
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

  /** 展平成同级行：跟随展开状态决定是否下钻（替代原先的递归渲染） */
  const rows = useMemo(() => flattenVisibleTree(displayTree, expanded), [displayTree, expanded]);

  // ---------- 大列表窗口化 ----------
  // 行高固定 30px，行数超阈值时只渲染视口附近的行，用占位高度撑住滚动条；
  // 阈值以下走原路径，小树零行为变化。
  const listRef = useRef<HTMLDivElement | null>(null);
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const virtual = rows.length > VIRTUAL_MIN_ROWS;

  // 收藏区/标签行在树之前，先量出"列表在滚动内容里的 y 偏移"再折算窗口，否则越滚越偏
  const measureWindow = useCallback(() => {
    const el = containerRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const listTop = list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const total = rows.length;
    const start = Math.max(0, Math.floor((el.scrollTop - listTop) / ROW_H) - VIRTUAL_OVERSCAN);
    const end = Math.min(total, Math.ceil((el.scrollTop - listTop + el.clientHeight) / ROW_H) + VIRTUAL_OVERSCAN);
    const next = { start, end: Math.max(end, Math.min(total, start + 1)) };
    setWin((prev) => (prev?.start === next.start && prev.end === next.end ? prev : next));
  }, [rows.length]);

  useEffect(() => {
    if (!virtual) {
      setWin(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    measureWindow();
    const onScroll = () => measureWindow();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => measureWindow());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [virtual, measureWindow]);

  const onMoveFail = (e: unknown) => {
    logger.error("move view failed", e);
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
      // 拒绝条件：目标是被拖项自身或其后代（防环）；注意参数顺序——
      // isDescendant(tree, ancestor, x) 判 "x 在 ancestor 子树内"，父级行不是自己的后代，必须放行
      if (targetId === s.id || isDescendant(cur, s.id, targetId)) {
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
        if (targetId !== s.id && !isDescendant(cur, s.id, targetId)) {
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

  // 首次 commit 还没量过窗口：先渲染开头一段，effect 量完立刻纠正
  const winStart = win?.start ?? 0;
  const winEnd = win?.end ?? Math.min(rows.length, VIRTUAL_OVERSCAN * 4);
  const renderRow = (r: VisibleTreeRow) => (
    <PageTreeItem
      key={r.node.id}
      node={r.node}
      depth={r.depth}
      draggingId={draggingId}
      dropHint={dropHint}
      onRowMouseDown={onRowMouseDown}
      onRowClick={onRowClick}
    />
  );

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
            const color = tagColor(tag, tagMeta);
            return (
              <button
                key={tag}
                className={
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition " +
                  (on ? "" : "text-neutral-500 hover:text-neutral-700")
                }
                style={{
                  borderColor: on ? color : tagTint(color, "66"),
                  backgroundColor: on ? tagTint(color, "1f") : undefined,
                  color: on ? color : undefined,
                }}
                onClick={() => setTagFilter(on ? null : tag)}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {tag}
                {on && <X className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}

      {rows.length === 0 && (
        <div className="px-2 py-3 text-center text-xs text-neutral-500">
          {tagFilter ? t("tree.noTagMatch") : t("tree.empty")}
        </div>
      )}
      {virtual ? (
        // 窗口化：外层撑出总高，行按固定行高绝对定位（首次 commit 未量过窗口时先渲染开头一段）
        <div ref={listRef} className="relative" style={{ height: rows.length * ROW_H }}>
          {rows.slice(winStart, winEnd).map((r, i) => (
            <div
              key={r.node.id}
              className="absolute left-0 right-0"
              style={{ top: (winStart + i) * ROW_H, height: ROW_H }}
            >
              {renderRow(r)}
            </div>
          ))}
        </div>
      ) : (
        rows.map(renderRow)
      )}
      {draggingId && !dropHint && <div className="mx-1 my-1 h-[2px] rounded bg-brand-500" />}
    </div>
  );
}
