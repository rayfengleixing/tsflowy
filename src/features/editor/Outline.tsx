import { useEffect, useMemo, useRef, useState } from "react";
import { Hash } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import { findNode } from "@/lib/tree";

const SIDEBAR_TAB_KEY = "tsflowy:ui:sidebar_tab";

interface HeadingItem {
  pos: number;
  level: number;
  text: string;
  /** 对应的 <h1>..<h6> DOM 元素缓存（减少 DOM 查找次数） */
  cachedDom?: HTMLElement | null;
}

const TK = {
  panelTitle: "sidebar.tab.outline",
  noDocument: "sidebar.outline.noDocument",
  empty: "sidebar.outline.empty",
} as const;

/**
 * 大纲侧栏 Tab（Phase 3.1）：
 *
 * 1. 从全局 useEditorStore 读取 editor（EditorPage 在挂载时推送，卸载时清空），
 *    不再依赖 props，让 Sidebar 兄弟节点也能访问。
 * 2. 仅当当前激活 view 是 document 布局时才采集 heading；其他布局（grid/board/calendar）
 *    显示"打开一个文档以查看大纲"占位提示。
 * 3. 点击条目 → 平滑滚动 editor 内容容器到该标题 + 光标定位（与原浮动版逻辑一致）。
 * 4. IntersectionObserver + 滚动 fallback 高亮当前可视区最靠上的标题。
 * 5. 内容直接内联渲染在 sidebar 容器内（不再 fixed 浮动）。
 */
export function DocumentOutline() {
  const editor = useEditorStore((s) => s.editor);
  const currentViewId = useEditorStore((s) => s.currentViewId);
  const tree = useWorkspaceStore((s) => s.tree);

  const currentView = currentViewId ? findNode(tree, currentViewId) : null;
  const isDocument = currentView?.layout === "document";

  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const scrollElRef = useRef<Element | null>(null);
  const activeItemsRef = useRef<Map<Element, number>>(new Map());
  // 缓存 headings 引用，避免 effect 闭包陈旧
  const headingsRef = useRef<HeadingItem[]>([]);
  headingsRef.current = headings;

  // 收集 headings + 订阅 editor 更新与选区变化
  useEffect(() => {
    if (!editor || !isDocument) {
      setHeadings([]);
      setActivePos(null);
      return;
    }

    const collect = () => {
      const list: HeadingItem[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading") {
          const level = (node.attrs.level as number) ?? 1;
          const text = node.textContent.trim().replace(/\s+/g, " ") || "(Untitled)";
          list.push({ pos, level, text });
        }
      });
      setHeadings(list);
    };

    const onSelectionChange = () => {
      const sel = editor.state.selection;
      let best: HeadingItem | null = null;
      for (const h of headingsRef.current) {
        if (h.pos <= sel.from) best = h;
        else break;
      }
      if (best) setActivePos(best.pos);
    };

    collect();
    editor.on("update", collect);
    editor.on("selectionUpdate", onSelectionChange);
    return () => {
      editor.off("update", collect);
      editor.off("selectionUpdate", onSelectionChange);
    };
  }, [editor, isDocument]);

  // 找到 editor 内容的 overflow-y 父容器（EditorPage 编辑区外层 overflow-auto）
  useEffect(() => {
    if (!editor?.view?.dom || !isDocument) {
      scrollElRef.current = null;
      return;
    }
    let el: Element | null = editor.view.dom;
    for (let i = 0; i < 8 && el; i++) {
      const ov = window.getComputedStyle(el).overflowY;
      if (ov === "auto" || ov === "scroll") break;
      el = el.parentElement;
    }
    scrollElRef.current = el ?? document.documentElement;
    return () => {
      scrollElRef.current = null;
    };
  }, [editor, isDocument]);

  // IntersectionObserver：监听每个 heading dom 进入视口
  useEffect(() => {
    if (!editor?.view?.dom || !isDocument) return;

    if (typeof IntersectionObserver === "undefined") {
      const sc = scrollElRef.current;
      if (!sc) return;
      const handler = () => scrollFindActive();
      sc.addEventListener("scroll", handler, { passive: true });
      window.addEventListener("resize", handler);
      return () => {
        sc.removeEventListener("scroll", handler);
        window.removeEventListener("resize", handler);
      };
    }

    ioRef.current?.disconnect();
    activeItemsRef.current.clear();

    const io = new IntersectionObserver(
      (entries) => {
        let currentBest: { pos: number; top: number } | null = null;
        for (const e of entries) {
          const pos = activeItemsRef.current.get(e.target);
          if (pos === undefined) continue;
          const rect = e.boundingClientRect;
          if (!e.isIntersecting) continue;
          const score = rect.top >= 0 ? rect.top : 10000 + Math.abs(rect.top);
          if (currentBest === null || score < currentBest.top) {
            currentBest = { pos, top: score };
          }
        }
        if (currentBest) setActivePos(currentBest.pos);
        else scrollFindActive();
      },
      {
        root: scrollElRef.current === document.documentElement ? null : scrollElRef.current,
        rootMargin: "-60px 0px -72% 0px",
        threshold: [0, 0.1, 1],
      },
    );
    ioRef.current = io;

    for (const h of headings) {
      const dom = findHeadingDom(editor, h.pos, headings);
      if (!dom) continue;
      activeItemsRef.current.set(dom, h.pos);
      io.observe(dom);
    }
    scrollFindActive();
    return () => {
      io.disconnect();
      activeItemsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, isDocument, headings]);

  /** 兜底：遍历 headings DOM，找视口最上方那个 */
  function scrollFindActive() {
    if (!editor) return;
    const current = headingsRef.current;
    let best: { pos: number; top: number } | null = null;
    const containerRect =
      scrollElRef.current instanceof HTMLElement ? scrollElRef.current.getBoundingClientRect() : null;
    const baseTop = containerRect ? containerRect.top : 0;
    for (const h of current) {
      const dom = findHeadingDom(editor, h.pos, current);
      if (!dom) continue;
      const r = dom.getBoundingClientRect();
      const rel = r.top - baseTop;
      const metric = rel <= 0 ? -1000000 + rel : rel;
      if (best === null || metric < best.top) {
        best = { pos: h.pos, top: metric };
      }
    }
    if (best) setActivePos(best.pos);
  }

  /** 按 PM pos 找到 <h1>..<h6> DOM（含缓存） */
  function findHeadingDom(
    ed: { view: { domAtPos: (p: number) => { node: Node; offset: number } } },
    pos: number,
    list: HeadingItem[],
  ): HTMLElement | null {
    const cached = list.find((x) => x.pos === pos)?.cachedDom;
    if (cached !== undefined) return cached || null;
    try {
      const result = ed.view.domAtPos(pos + 1);
      let node: Node | null = result.node;
      while (node && node.nodeType !== 1) node = node.parentNode;
      let el = node as HTMLElement | null;
      while (el && !/^h[1-6]$/i.test(el.tagName)) {
        el = el.parentElement;
      }
      const item = list.find((x) => x.pos === pos);
      if (item) item.cachedDom = el ?? null;
      return el;
    } catch {
      return null;
    }
  }

  /** 点击：平滑滚动到该标题 + 光标定位 */
  function jumpTo(h: HeadingItem) {
    if (!editor) return;
    const dom = findHeadingDom(editor, h.pos, headingsRef.current);
    const sc = scrollElRef.current as HTMLElement | null;
    if (dom && sc) {
      const containerRect = sc.getBoundingClientRect();
      const r = dom.getBoundingClientRect();
      const targetScroll = sc.scrollTop + (r.top - containerRect.top) - 16;
      sc.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
    } else if (dom) {
      dom.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    editor
      .chain()
      .focus()
      .setTextSelection(h.pos + 1)
      .run();
    setActivePos(h.pos);
  }

  const indentBy = (level: number) => `${Math.max(0, Math.min(6, level) - 1) * 12}px`;
  const levelStyle = useMemo(
    () => (level: number) => {
      const sizes: Record<number, string> = {
        1: "text-[13px] font-semibold text-neutral-700",
        2: "text-[12.5px] font-medium text-neutral-700",
        3: "text-[12px] text-neutral-600",
      };
      return sizes[level] ?? "text-[12px] text-neutral-500";
    },
    [],
  );

  // 非文档视图：占位提示
  if (!isDocument) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
        <Hash className="mb-2 h-5 w-5 text-neutral-300" />
        <p className="text-[12px] text-neutral-400">{t(TK.noDocument)}</p>
      </div>
    );
  }

  // 文档视图但无标题
  if (headings.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
        <Hash className="mb-2 h-5 w-5 text-neutral-300" />
        <p className="text-[12px] text-neutral-400">{t(TK.empty)}</p>
      </div>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto px-1 py-2" aria-label={t(TK.panelTitle)}>
      <ul className="space-y-0.5">
        {headings.map((h) => {
          const isActive = activePos === h.pos;
          return (
            <li key={h.pos}>
              <button
                type="button"
                onClick={() => jumpTo(h)}
                style={{ paddingLeft: indentBy(h.level) }}
                className={[
                  "group block w-full rounded-md border-l-2 px-2.5 py-1.5 pr-2 text-left transition",
                  isActive ? "border-brand-500 bg-brand-50 text-brand-800" : "border-transparent hover:bg-neutral-100",
                ].join(" ")}
              >
                <span
                  className={["block truncate", levelStyle(h.level), isActive ? "text-brand-800" : ""].join(" ")}
                  title={h.text}
                >
                  {h.text}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ——————————————————————————————————————
// Sidebar Tab 切换状态持久化（小工具函数）
// 旧版 OUTLINE_STORAGE_KEY 已废弃，新 key 是 sidebar_tab（tree/outline）。
// ——————————————————————————————————————
export function getSidebarTab(): "tree" | "outline" {
  try {
    const v = localStorage.getItem(SIDEBAR_TAB_KEY);
    if (v === "outline") return v;
  } catch {
    /* ignore */
  }
  return "tree";
}

export function setSidebarTab(v: "tree" | "outline"): void {
  try {
    localStorage.setItem(SIDEBAR_TAB_KEY, v);
  } catch {
    /* ignore */
  }
}
