import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Star, X } from "lucide-react";
import { parseViewTags } from "@/types/models";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageTreeItem, type DropHint } from "./PageTreeItem";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  dropTarget,
  filterTreeByTag,
  flattenTree,
  flattenVisibleTree,
  isDescendant,
  pruneSubtreeSelection,
  visibleRangeSelection,
  type DropZone,
  type VisibleTreeRow,
} from "@/lib/doc/tree";
import { t } from "@/lib/i18n";
import { isInsidePopup } from "@/lib/radix-popup";
import { tagColor, tagTint } from "@/lib/doc/tags";
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
 *  顶部含收藏区（跨目录快速入口）与标签过滤行（点击按标签过滤树）。
 *  多选（右键菜单「选择」/ Ctrl / Shift / Ctrl+A）后，在选中的行上右键 → 菜单的收藏 / 删除对整组生效。
 *  行是 role=treeitem（层级用 aria-level 表达），方向键走 roving tabindex。 */
export function PageTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const moveView = useWorkspaceStore((s) => s.moveView);
  const openView = useWorkspaceStore((s) => s.openView);
  const expand = useWorkspaceStore((s) => s.expand);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const tagMeta = useWorkspaceStore((s) => s.tagMeta);
  const setViewFavorite = useWorkspaceStore((s) => s.setViewFavorite);
  const deleteView = useWorkspaceStore((s) => s.deleteView);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  /** 多选选区（右键菜单「选择」/ Ctrl 加选 / Shift 连选 / 方向键扩选）；批量操作后清空 */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** Shift 连选与扩选的锚点行 */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  /** 键盘焦点行（roving tabindex 的那一个）；与选区分离，方向键移动它 */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 行 DOM（id → 元素）：窗口化滚动后按 id 找回该行元素聚焦 */
  const rowEls = useRef(new Map<string, HTMLElement>());
  /** 拖拽会话（mousedown 记录 → mousemove 超阈值进入拖拽 → mouseup 落点）；ids 是这一拖要搬的整组 */
  const sessionRef = useRef<{ id: string; ids: string[]; startX: number; startY: number; moved: boolean } | null>(null);
  /** 真的搬动过之后抑制同帧 click（未搬成则不抑制，让 click 走打开） */
  const suppressClickRef = useRef(false);
  /** window 级监听里要读最新选区，但监听不该因选区变化反复重挂 */
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const favorites = useMemo(() => flattenTree(tree).filter((v) => v.is_favorite === 1), [tree]);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const v of flattenTree(tree)) for (const tag of parseViewTags(v.tags)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tree]);

  const displayTree = useMemo(() => (tagFilter ? filterTreeByTag(tree, tagFilter) : tree), [tree, tagFilter]);

  /** 展平成同级行：跟随展开状态决定是否下钻（替代原先的递归渲染） */
  const rows = useMemo(() => flattenVisibleTree(displayTree, expanded), [displayTree, expanded]);

  // 删除/移动后选区里可能残留已经不存在的 id，批量操作会对空 id 报错，树变化时顺手剔掉
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(flattenTree(tree).map((n) => n.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tree]);

  /** 本次要搬动的页面：拖已选中的行 → 整组一起走；父子同选只留父页（子树跟着父页走） */
  const movingIds = useCallback((id: string): string[] => {
    const cur = useWorkspaceStore.getState().tree;
    const sel = selectionRef.current;
    const picked = sel.has(id) && sel.size > 1 ? [...sel] : [id];
    return pruneSubtreeSelection(cur, picked);
  }, []);

  /** 落点合法性：不能落在被搬项自身或其后代里（防环，整组任一成员都算） */
  const canDropOn = useCallback((ids: string[], targetId: string) => {
    const cur = useWorkspaceStore.getState().tree;
    return !ids.some((id) => id === targetId || isDescendant(cur, id, targetId));
  }, []);

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

  const onMoveFail = useCallback((e: unknown) => {
    logger.error("move view failed", e);
    toast.error(t("error.db", { message: String(e) }));
  }, []);

  /** 批量落点：逐个搬，后一个落在前一个之后（index + i），顺序跟选区一致 */
  const handleDrop = useCallback(
    async (ids: string[], targetId: string, zone: DropZone) => {
      const target = dropTarget(tree, targetId, zone);
      if (!target) return;
      try {
        for (let i = 0; i < ids.length; i++) await moveView(ids[i], target.parentId, target.index + i);
      } catch (e: unknown) {
        onMoveFail(e);
      }
    },
    [tree, moveView, onMoveFail],
  );

  /** 空白处落点：整组追加到根级末尾。逐个 await（并发重排会互相踩位置） */
  const handleDropAtRoot = useCallback(
    async (ids: string[]) => {
      const total = useWorkspaceStore.getState().tree.length;
      try {
        for (let i = 0; i < ids.length; i++) await moveView(ids[i], null, total + i);
      } catch (e: unknown) {
        onMoveFail(e);
      }
    },
    [moveView, onMoveFail],
  );

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
        // 确认是在拖了才把这一组涂成选中项：mousedown 就涂色的话，手抖一下看起来像「只选中没打开」
        if (!selectionRef.current.has(s.id)) {
          setSelection(new Set(s.ids));
          setAnchorId(s.id);
        }
        setDraggingId(s.id);
      }
      const row = rowAt(e.target);
      if (!row?.dataset.treeRow) {
        setDropHint(null);
        return;
      }
      const targetId = row.dataset.treeRow;
      // 拒绝条件：落点是被搬组里的任一项或其后代（防环）；注意参数顺序——
      // isDescendant(tree, ancestor, x) 判 "x 在 ancestor 子树内"，父级行不是自己的后代，必须放行
      if (!canDropOn(s.ids, targetId)) {
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
      let dropped = false;
      const row = rowAt(e.target);
      if (row?.dataset.treeRow) {
        const targetId = row.dataset.treeRow;
        if (canDropOn(s.ids, targetId)) {
          const zone = zoneForEl(row, e.clientY);
          if (zone === "inside") expand(targetId);
          void handleDrop(s.ids, targetId, zone);
          dropped = true;
        }
      } else if (containerRef.current?.contains(e.target as Node)) {
        // 树容器空白处落点 → 整组移到根级末尾
        void handleDropAtRoot(s.ids);
        dropped = true;
      }
      // 吞掉这次 click 的两种情况：真搬动了；指针已经离开按下时那一行（认真的拖拽，
      // 哪怕落点非法没搬成，也不该顺手打开落点处的页面）。
      // 留在原行又没搬成 = 只是手抖超过阈值，必须放行 click，否则就成了「第一下只选中，第二下才打开」
      if (dropped || row?.dataset.treeRow !== s.id) {
        suppressClickRef.current = true;
        setTimeout(() => (suppressClickRef.current = false));
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
  }, [expand, handleDrop, handleDropAtRoot, canDropOn]);

  /** 行点击：Ctrl/Cmd 加选、Shift 连选，普通点击清空选区并打开页面 */
  const onRowClick = (id: string, e: React.MouseEvent) => {
    // 行菜单 / 图标选择器是行的 React 后代，菜单项的点击会冒泡到这里；
    // 不挡回来，右键「选择」刚把这页加进选区就被当成普通点击清空了
    if (isInsidePopup(e.target)) return;
    setFocusedId(id);
    if (suppressClickRef.current) return;
    if (e.shiftKey) {
      setSelection(new Set(visibleRangeSelection(rows, anchorId ?? id, id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchorId(id);
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setAnchorId(id);
    setSelection(new Set());
    openView(id);
  };

  /** 行 mousedown：左键且不在交互控件上时记下潜在拖拽会话（选区留到真的拖动或点击时才动） */
  const onRowMouseDown = (id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isInsidePopup(e.target)) return;
    if ((e.target as HTMLElement).closest("button, input, a, [role=button]")) return;
    e.preventDefault(); // 防止拖拽选中文本
    // 先按当前选区算好这一拖搬哪些（选区里的行 → 整组；否则只搬它自己）
    const ids = movingIds(id);
    sessionRef.current = { id, ids, startX: e.clientX, startY: e.clientY, moved: false };
  };

  /** 右键菜单里的「选择 / 取消选择」：加撤这一页但不清空已有选区，与 Ctrl 点选同义 */
  const toggleSelect = useCallback((id: string) => {
    setAnchorId(id);
    setFocusedId(id);
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 行右键：落在选区外（或选区只有一页）时先清掉旧选区，让菜单里的操作和肉眼看到的选中状态一致 */
  const onRowContextMenu = useCallback((id: string) => {
    const sel = selectionRef.current;
    if (sel.has(id) && sel.size > 1) return;
    setSelection(new Set());
    setAnchorId(id);
  }, []);

  const registerRow = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  }, []);

  /** 键盘导航用的聚焦：窗口化时目标行可能还没渲染，先把它滚进视口，下一帧再聚焦 */
  const focusRow = (target: VisibleTreeRow) => {
    const id = target.node.id;
    const index = rows.indexOf(target);
    setFocusedId(id);
    const el = containerRef.current;
    const list = listRef.current;
    if (index >= 0 && el && list) {
      const listTop = list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const rowTop = listTop + index * ROW_H;
      if (rowTop < el.scrollTop) el.scrollTop = Math.max(0, rowTop - 4);
      else if (rowTop + ROW_H > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowTop + ROW_H - el.clientHeight + 4;
      }
    }
    requestAnimationFrame(() => rowEls.current.get(id)?.focus());
  };

  /** 批量操作只碰「最上层选中项」：父子同选时子页随父页整棵走，不必重复操作 */
  const batchIds = useMemo(() => pruneSubtreeSelection(tree, [...selection]), [tree, selection]);

  const runBatch = useCallback(
    async (fn: (id: string) => Promise<void>) => {
      const ids = batchIds;
      setSelection(new Set());
      setAnchorId(null);
      try {
        for (const id of ids) await fn(id);
      } catch (e: unknown) {
        logger.error("page tree batch failed", e);
        toast.error(t("error.db", { message: String(e) }));
      }
    },
    [batchIds],
  );

  /** 右键菜单里的批量收藏 / 取消收藏 */
  const runBatchFavorite = useCallback(
    (favorite: boolean) => {
      void runBatch((id) => setViewFavorite(id, favorite));
    },
    [runBatch, setViewFavorite],
  );

  /** 树内键盘导航：↑↓/Home/End 移动焦点，Shift+方向键扩选，←→收起/展开，Enter 打开，Ctrl+A 全选，Del 批量删 */
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 || e.nativeEvent.isComposing) return;
    const id = (e.target as HTMLElement).dataset.treeRow;
    if (!id) return; // 焦点在行内控件（图标/按钮）上时由控件自己处理
    const index = rows.findIndex((r) => r.node.id === id);
    if (index < 0) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection(new Set(rows.map((r) => r.node.id)));
      return;
    }
    if (e.key === "Escape") {
      setSelection(new Set());
      return;
    }
    if (e.key === "Delete" && selection.size > 0) {
      e.preventDefault();
      setConfirmBatchDelete(true);
      return;
    }

    const last = rows.length - 1;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(last, index + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next >= 0) {
      e.preventDefault();
      const nextId = rows[next].node.id;
      // Shift+方向键从锚点扩选（锚点不变），普通方向键把锚点跟着焦点走
      if (e.shiftKey) setSelection(new Set(visibleRangeSelection(rows, anchorId ?? id, nextId)));
      else setAnchorId(nextId);
      focusRow(rows[next]);
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // 与单击打开一致：打开这一页就把选区清空，别让涂色一直挂在树上
      setAnchorId(id);
      setSelection(new Set());
      openView(id);
      return;
    }

    const node = rows[index].node;
    const hasChildren = node.children.length > 0;
    if (e.key === "ArrowRight") {
      if (hasChildren && !expanded.has(node.id)) {
        e.preventDefault();
        expand(node.id);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (hasChildren && expanded.has(node.id)) {
        toggleExpand(node.id);
        return;
      }
      // 已收起或没有子页：焦点回到父页行
      const parentRow = node.parent_id ? rows.find((r) => r.node.id === node.parent_id) : undefined;
      if (parentRow) focusRow(parentRow);
    }
  };

  // 首次 commit 还没量过窗口：先渲染开头一段，effect 量完立刻纠正
  const winStart = win?.start ?? 0;
  const winEnd = win?.end ?? Math.min(rows.length, VIRTUAL_OVERSCAN * 4);
  /** roving tabindex：焦点行是 Tab 落点；焦点行不在可见区（折叠/删除后）时退到窗口首行 */
  const tabbableId = rows.some((r) => r.node.id === focusedId) ? focusedId : (rows[winStart]?.node.id ?? null);
  const renderRow = (r: VisibleTreeRow) => (
    <PageTreeItem
      key={r.node.id}
      node={r.node}
      depth={r.depth}
      draggingId={draggingId}
      dropHint={dropHint}
      selected={selection.has(r.node.id)}
      /** 这一行处在多页选区里 → 菜单的收藏 / 删除改成对整组生效（0 = 单页操作） */
      batchCount={selection.size > 1 && selection.has(r.node.id) ? batchIds.length : 0}
      tabbable={r.node.id === tabbableId}
      registerRow={registerRow}
      onRowMouseDown={onRowMouseDown}
      onRowClick={onRowClick}
      onRowContextMenu={onRowContextMenu}
      onToggleSelect={toggleSelect}
      onBatchFavorite={runBatchFavorite}
      onBatchDelete={() => setConfirmBatchDelete(true)}
    />
  );

  return (
    <>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-2 pb-2 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
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
        {/* role=tree：行是展平的 treeitem，层级靠 aria-level 表达（窗口化的绝对定位包装层不参与语义） */}
        <div
          ref={listRef}
          role="tree"
          aria-label={t("tree.list")}
          aria-multiselectable="true"
          onKeyDown={onTreeKeyDown}
          className={virtual ? "relative" : undefined}
          style={virtual ? { height: rows.length * ROW_H } : undefined}
        >
          {virtual
            ? rows.slice(winStart, winEnd).map((r, i) => (
                <div
                  key={r.node.id}
                  role="presentation"
                  className="absolute left-0 right-0"
                  style={{ top: (winStart + i) * ROW_H, height: ROW_H }}
                >
                  {renderRow(r)}
                </div>
              ))
            : rows.map(renderRow)}
        </div>
        {draggingId && !dropHint && <div className="mx-1 my-1 h-[2px] rounded bg-brand-500" />}
      </div>

      <ConfirmDialog
        open={confirmBatchDelete}
        onOpenChange={setConfirmBatchDelete}
        title={t("tree.confirmBatchDeleteTitle")}
        description={t("tree.confirmBatchDeleteDesc", { count: batchIds.length })}
        onConfirm={() => runBatch((id) => deleteView(id))}
      />
    </>
  );
}
