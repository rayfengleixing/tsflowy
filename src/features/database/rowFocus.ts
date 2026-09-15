import { useEffect, useRef, type RefObject } from "react";
import { useDatabaseStore } from "@/stores/database";

// 搜索命中的行定位（阶段 3 #5）：Rust 侧把命中的单元格 row_id 一起带出来，
// 这里负责滚动到那一行并短时高亮。状态记在 database store 的 focusRowId 上，
// 不放 lib/search.ts —— lib 模块不 import store。

/** 高亮停留时长：够看清位置，又不至于常驻 */
const FOCUS_MS = 2400;

/** 命中行高亮底色（表格行 / 看板卡片 / 日历卡片共用） */
export const ROW_FOCUS_CLASS = "bg-brand-100/70 dark:bg-brand-600/20";

/** 滚动到命中行并居中；元素不在（被筛选掉、不属这个视图）时返回 false */
export function scrollToRow(scope: HTMLElement | null, rowId: string): boolean {
  if (!scope) return false;
  const el = scope.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  return true;
}

/**
 * 命中行定位钩子：视图把自身滚动容器挂到 scrollerRef，行元素带 data-row-id。
 * revision 传"决定命中行是否渲染出来"的状态（分组是否折叠、日历翻到哪个月），
 * 变化后重跑一次，保证先展开/翻页、再定位。
 */
export function useRowFocus(revision: unknown): {
  scrollerRef: RefObject<HTMLDivElement | null>;
  focusRowId: string | null;
} {
  const focusRowId = useDatabaseStore((s) => s.focusRowId);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focusRowId) return;
    // 等这一帧渲染完再定位（分组展开、月份切换的结果要生效）
    const raf = requestAnimationFrame(() => {
      scrollToRow(scrollerRef.current, focusRowId);
    });
    const timer = window.setTimeout(() => {
      useDatabaseStore.getState().clearFocusRow();
    }, FOCUS_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [focusRowId, revision]);

  return { scrollerRef, focusRowId };
}
