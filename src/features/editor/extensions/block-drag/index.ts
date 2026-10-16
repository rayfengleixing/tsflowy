// 块拖拽扩展（Phase 4.3 Block Drag）
//
// 实现方式：自定义 TipTap Extension（非 NodeView 方式），
//   - addOptions: 默认行为；
//   - addProseMirrorPlugins: 返回自定义 Plugin + PluginView，它会在 editor.view.dom 旁侧
//     挂一个 handle 容器（最小实现，直接写 DOM，不引入 React）。
//   - handle 仅显示在顶层块左侧（doc 直接子节点），支持三种交互：
//       · 按住拖动（mouse 事件链，不用 HTML5 drag——WebView2/自动化环境不可靠）→ 排序
//       · 单击 → 派发 BLOCK_MENU_EVENT，由 React 块菜单（block-menu.tsx）接管
//       · Shift 单击 → 从上一个锚点块扩出连续多选区间；此后拖动/菜单/退格都作用于整段
//   - Alt+↑/↓ 移动当前块（或整个多选区间），Escape 取消多选。
//   - drop 只按"前/后"插入目标块相邻位置（不做精确坐标命中块内容中间），
//     避免 posAtCoords 在嵌入表格/数据库视图中产生的各种坑。
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { BLOCK_MENU_EVENT, type BlockMenuPayload } from "@/features/editor/block-menu";
import { deleteBlockSpan, moveBlockSpan } from "@/features/editor/block-ops";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import {
  BLOCK_SELECTION_META,
  BLOCK_SELECTION_KEY,
  blockSelectionPlugin,
  buildSpanMoveTr,
  expandSpan,
  isProtectedPos,
  spanForAction,
  type BlockSpan,
} from "../block-selection";

const PLUGIN_KEY = new PluginKey<{ draggingDom: HTMLElement | null }>("block-drag");

/** 多选高亮打在顶层块 DOM 上，样式见 index.css 的 `.tiptap > [data-ts-selected]` */
const SELECTED_ATTR = "data-ts-selected";

function sameSpan(a: BlockSpan | null, b: BlockSpan | null): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to && a.count === b.count;
}

const HANDLE_CLASS = "block-drag-handle";
const HANDLE_WIDTH = 20; // px，含 padding
/** 拖拽启动阈值（px） */
const DRAG_THRESHOLD = 5;
// 自带拖拽手柄的块（NodeViewWrapper 上标了 data-drag-handle，见 image/columns/gallery 等组件）：
// 通用手柄不再叠加显示。注意不能把它们从 listTopBlocks 里整个剔除——
// 该列表同时是 drop 目标来源，剔除后拖拽指示条会跳过这些块定位到更远的块。
// （旧实现按 data-node-type 匹配 SKIP_BLOCK_TYPES，但全库没有任何节点渲染该属性，等于死代码）
function hasOwnDragHandle(el: HTMLElement): boolean {
  return el.hasAttribute("data-drag-handle") || el.querySelector("[data-drag-handle]") !== null;
}

/** 顶层块信息列表（按 DOM 顺序），用于根据鼠标 Y 计算 hover 目标。 */
function listTopBlocks(
  view: EditorView,
): { dom: HTMLElement; top: number; bottom: number; left: number; width: number; pos: number; size: number }[] {
  const docEl = view.dom;
  const rects: {
    dom: HTMLElement;
    top: number;
    bottom: number;
    left: number;
    width: number;
    pos: number;
    size: number;
  }[] = [];
  for (const child of Array.from(docEl.children) as HTMLElement[]) {
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // posAtDOM 是 DOM→文档位置的直接映射；posAtCoords（坐标命中）要跑一次完整
    // hit-test，这里每个块都调一次，在 mousemove 热路径上代价过大
    let inner: number;
    try {
      inner = view.posAtDOM(child, 0);
    } catch {
      continue;
    }
    const $ = view.state.doc.resolve(inner);
    const pos = $.depth >= 1 ? $.before(Math.min($.depth, 1)) : $.pos;
    const size = view.state.doc.nodeAt(pos)?.nodeSize ?? 0;
    // 文档结构锁定块（首行 H1 标题 / 第二行分割线）：不显示手柄、不作为拖拽目标
    if (!size || isProtectedPos(view.state.doc, pos)) continue;
    rects.push({ dom: child, top: r.top, bottom: r.bottom, left: r.left, width: r.width, pos, size });
  }
  return rects;
}

export const BlockDrag = Extension.create({
  name: "blockDrag",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      blockSelectionPlugin(),
      new Plugin({
        key: PLUGIN_KEY,
        view(view) {
          return new BlockDragView(view, editor);
        },
        state: {
          init: () => ({ draggingDom: null }),
          apply: (_tr, prev) => prev,
        },
        props: {
          // 手柄键盘操作：Alt+↑/↓ 整段搬移、退格删除整段、Escape 取消多选。
          // 放在插件 props 而不是 EditorPage 的 editorProps：这三条只在"有块选中"时
          // 才接管按键，其余情况一律 return false 让按键透传。
          handleKeyDown: (view, event) => handleBlockKey(view, event, editor),
        },
      }),
    ];
  },
});

/** 手柄键盘交互；返回 true 表示按键已被消费 */
function handleBlockKey(view: EditorView, event: KeyboardEvent, editor: Editor): boolean {
  const span = BLOCK_SELECTION_KEY.getState(view.state) ?? null;
  if (event.key === "Escape") {
    if (!span) return false;
    view.dispatch(view.state.tr.setMeta(BLOCK_SELECTION_META, null));
    return true;
  }
  const up = event.key === "ArrowUp";
  const down = event.key === "ArrowDown";
  if (event.altKey && !event.ctrlKey && !event.metaKey && (up || down)) {
    // spanForAction：有多选就搬整段，没有就搬光标所在的单个顶层块
    const target = spanForAction(view.state);
    if (!target) return false;
    return moveBlockSpan(editor, target, up ? -1 : 1);
  }
  // 只有真正多选（≥2 块）才劫持退格：单块高亮时用户大概只是想改字
  if ((event.key === "Backspace" || event.key === "Delete") && span && span.count >= 2) {
    return deleteBlockSpan(editor, span);
  }
  return false;
}

// ——————————————————————————————————————
// PluginView：handle DOM 管理 + 拖拽/点击事件
// ——————————————————————————————————————
class BlockDragView {
  handle: HTMLDivElement;
  view: EditorView;
  editor: Editor;
  /** 当前 hover 的顶层块 */
  hover: HTMLElement | null = null;
  /** 拖拽会话：按下点 + 源块信息（moved 表示已超过阈值进入拖拽）；
   *  span 非空表示拖的是整个多选区间，doms 是这一组块的 DOM（一起变淡） */
  dragging: {
    pos: number;
    node: PMNode;
    dom: HTMLElement;
    doms: HTMLElement[];
    span: BlockSpan | null;
    startX: number;
    startY: number;
    moved: boolean;
  } | null = null;
  /** Shift 扩选的锚点块起点（点击手柄时更新；区间被清空后仍保留，方便连着 shift 点） */
  private anchor: number | null = null;
  /** 上一次画到 DOM 上的选中区间，用于避免每帧重画 */
  private painted: BlockSpan | null = null;
  /** 拖拽目标：前/后（size 是目标块自身的宽度，after 时用来算插入坐标） */
  dropTarget: { type: "before" | "after"; sibling: HTMLElement; pos: number; size: number } | null = null;
  dropIndicator: HTMLDivElement;
  /** 普通 hover 的 rAF 合并（mousemove 高频事件里全量扫描顶层块代价高） */
  private hoverRaf = 0;
  private lastHoverEvent: MouseEvent | null = null;
  /** 拖拽中同样按帧合并：updateDropTarget 每次都要全量扫描顶层块 */
  private dragRaf = 0;
  private lastDragY: number | null = null;

  constructor(view: EditorView, editor: Editor) {
    this.view = view;
    this.editor = editor;
    this.handle = document.createElement("div");
    this.handle.className = HANDLE_CLASS;
    this.handle.title = t("block.dragHandle");
    this.handle.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
      '<circle cx="5" cy="3" r="1.1" fill="currentColor"/>' +
      '<circle cx="9" cy="3" r="1.1" fill="currentColor"/>' +
      '<circle cx="5" cy="7" r="1.1" fill="currentColor"/>' +
      '<circle cx="9" cy="7" r="1.1" fill="currentColor"/>' +
      '<circle cx="5" cy="11" r="1.1" fill="currentColor"/>' +
      '<circle cx="9" cy="11" r="1.1" fill="currentColor"/>' +
      "</svg>";
    // 样式：fixed 定位，跟随 hover block；颜色同 outline handle；隐藏时透明
    Object.assign(this.handle.style, {
      position: "fixed",
      zIndex: "25",
      display: "none",
      width: `${HANDLE_WIDTH}px`,
      height: "22px",
      padding: "3px",
      boxSizing: "border-box",
      cursor: "grab",
      color: "#a3a3a3",
      borderRadius: "4px",
      userSelect: "none",
    } as Partial<CSSStyleDeclaration>);
    this.handle.addEventListener("mouseenter", () => {
      this.handle.style.color = "#171717";
      this.handle.style.background = "#f5f5f5";
    });
    this.handle.addEventListener("mouseleave", () => {
      this.handle.style.color = "#a3a3a3";
      this.handle.style.background = "";
    });

    this.dropIndicator = document.createElement("div");
    Object.assign(this.dropIndicator.style, {
      position: "fixed",
      zIndex: "25",
      height: "2px",
      background: "#2563eb",
      borderRadius: "2px",
      boxShadow: "0 0 0 1px rgba(37,99,235,0.15)",
      display: "none",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);

    // 挂到 body（editor 外层可能有 overflow:auto，避免被裁剪）
    document.body.appendChild(this.handle);
    document.body.appendChild(this.dropIndicator);

    // 事件绑定：mouse 事件链（不用 HTML5 drag：WebView2/自动化下 dragstart 不可靠）
    this.handle.addEventListener("mousedown", this.onHandleMouseDown);
    window.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("mouseup", this.onMouseUp, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  onHandleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 防止浏览器发起文本选区/拖拽
    const blockDom: HTMLElement | null = (this.handle as HTMLElement & { _blockDom?: HTMLElement })._blockDom ?? null;
    if (!blockDom) return;
    const blocks = listTopBlocks(this.view);
    const info = blocks.find((b) => b.dom === blockDom);
    if (!info) return;
    const node = this.view.state.doc.nodeAt(info.pos);
    if (!node) return;
    const stored = BLOCK_SELECTION_KEY.getState(this.view.state) ?? null;

    // Shift 点手柄：从锚点扩出连续区间，不进入拖拽（否则按住 shift 想扩选却把块拖走了）
    if (e.shiftKey) {
      const span = expandSpan(this.view.state.doc, this.anchor, info.pos);
      if (span) {
        this.view.dispatch(this.view.state.tr.setMeta(BLOCK_SELECTION_META, span));
        this.anchor = span.from;
      }
      return;
    }

    // 普通点击：落在已有多选区间里就保持整段（菜单和拖拽都作用于整段），
    // 否则收起整段、以这一块为新锚点
    const inside = !!stored && info.pos >= stored.from && info.pos < stored.to;
    if (stored && !inside) {
      this.view.dispatch(this.view.state.tr.setMeta(BLOCK_SELECTION_META, null));
    }
    this.anchor = info.pos;
    const span = inside ? stored : null;
    const doms = span ? blocks.filter((b) => b.pos >= span.from && b.pos < span.to).map((b) => b.dom) : [blockDom];
    this.dragging = {
      pos: info.pos,
      node,
      dom: blockDom,
      doms,
      span,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  };

  onMouseMove = (e: MouseEvent) => {
    if (this.dragging) {
      // 未超过阈值：仍是"潜在点击"，不进入拖拽
      if (!this.dragging.moved) {
        const dx = e.clientX - this.dragging.startX;
        const dy = e.clientY - this.dragging.startY;
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        this.dragging.moved = true;
        for (const d of this.dragging.doms) d.style.opacity = "0.5";
        this.hideHandle();
      }
      this.lastDragY = e.clientY;
      if (this.dragRaf) return;
      this.dragRaf = requestAnimationFrame(() => {
        this.dragRaf = 0;
        const y = this.lastDragY;
        if (y !== null && this.dragging?.moved) this.updateDropTarget(y);
      });
      return;
    }
    // 普通 hover：按帧合并（回调里再判断是否在 editor 范围内）
    this.lastHoverEvent = e;
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const ev = this.lastHoverEvent;
      if (ev) this.updateHover(ev);
    });
  };

  /** 普通 hover：在 editor 范围内显示手柄 */
  updateHover(e: MouseEvent) {
    const root = this.view.dom.getBoundingClientRect();
    if (
      e.clientX < root.left - 60 ||
      e.clientX > root.right + 10 ||
      e.clientY < root.top - 10 ||
      e.clientY > root.bottom + 10
    ) {
      this.hideHandle();
      return;
    }
    const blocks = listTopBlocks(this.view);
    let target: (typeof blocks)[number] | null = null;
    for (const b of blocks) {
      if (e.clientY >= b.top - 2 && e.clientY < b.bottom + 2) {
        target = b;
        break;
      }
    }
    if (!target) {
      this.hideHandle();
      return;
    }
    if (hasOwnDragHandle(target.dom)) {
      this.hideHandle();
      return;
    }
    this.showHandle(target.dom);
  }

  onMouseUp = (_e: MouseEvent) => {
    if (!this.dragging) return;
    const session = this.dragging;
    if (session.moved) {
      // 最后一帧的 mousemove 可能还没跑：同步补算，避免松手瞬间丢目标
      if (this.dragRaf) {
        cancelAnimationFrame(this.dragRaf);
        this.dragRaf = 0;
        if (this.lastDragY !== null) this.updateDropTarget(this.lastDragY);
      }
      this.performDrop();
    } else {
      // 点击（未超过拖拽阈值）→ 打开块菜单
      this.openBlockMenu(session.pos, session.node);
    }
    this.onDragEnd();
  };

  onScroll = () => {
    // 滚动时隐藏 handle 并取消未完成的拖拽会话（下次 mousemove 再重新定位）
    if (this.hoverRaf) {
      cancelAnimationFrame(this.hoverRaf);
      this.hoverRaf = 0;
    }
    this.lastHoverEvent = null;
    if (this.dragRaf) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
    this.lastDragY = null;
    this.hideHandle();
    this.clearDropTarget();
    if (this.dragging && !this.dragging.moved) this.dragging = null;
  };

  showHandle(blockDom: HTMLElement) {
    if (this.hover === blockDom) return;
    this.hover = blockDom;
    const r = blockDom.getBoundingClientRect();
    this.handle.style.display = "flex";
    this.handle.style.alignItems = "center";
    this.handle.style.justifyContent = "center";
    const left = r.left - HANDLE_WIDTH - 4; // 贴块左侧外 4px
    const top = r.top + Math.max(2, (r.height - 22) / 2);
    this.handle.style.left = `${left}px`;
    this.handle.style.top = `${top}px`;
    // 数据联动：handle 上存当前块对应的数据（避免拖放时重新扫描 DOM）
    (this.handle as HTMLElement & { _blockDom?: HTMLElement })._blockDom = blockDom;
  }

  hideHandle() {
    if (this.hover === null && this.handle.style.display === "none") return;
    this.hover = null;
    this.handle.style.display = "none";
  }

  /** 根据鼠标 Y 计算 before/after 目标并更新蓝色指示条 */
  updateDropTarget(clientY: number) {
    const blocks = listTopBlocks(this.view);
    let target: {
      type: "before" | "after";
      pos: number;
      size: number;
      sibling: HTMLElement;
      top: number;
      left: number;
      width: number;
    } | null = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const mid = (b.top + b.bottom) / 2;
      if (clientY < mid) {
        target = {
          type: "before",
          pos: b.pos,
          size: b.size,
          sibling: b.dom,
          top: b.top - 1,
          left: b.left,
          width: b.width,
        };
        break;
      }
      if (i === blocks.length - 1) {
        target = {
          type: "after",
          pos: b.pos,
          size: b.size,
          sibling: b.dom,
          top: b.bottom - 1,
          left: b.left,
          width: b.width,
        };
      }
    }
    if (!target || !this.dragging) return;
    // 目标就是被拖的那一块（或多选区间里的一块）→ 不显示指示
    if (this.dragging.doms.includes(target.sibling)) {
      this.clearDropTarget();
      return;
    }
    this.dropTarget = { type: target.type, sibling: target.sibling, pos: target.pos, size: target.size };
    this.dropIndicator.style.display = "block";
    this.dropIndicator.style.top = `${target.top}px`;
    this.dropIndicator.style.left = `${target.left}px`;
    this.dropIndicator.style.width = `${target.width}px`;
  }

  clearDropTarget() {
    this.dropTarget = null;
    this.dropIndicator.style.display = "none";
  }

  performDrop() {
    if (!this.dragging || !this.dropTarget) return;
    try {
      const span = this.dragging.span ?? {
        from: this.dragging.pos,
        to: this.dragging.pos + this.dragging.node.nodeSize,
        count: 1,
      };
      // before → 目标块起点；after → 目标块末尾（也就是下一块的起点，末尾时即 content.size）
      const insertBefore =
        this.dropTarget.type === "before" ? this.dropTarget.pos : this.dropTarget.pos + this.dropTarget.size;
      const tr = buildSpanMoveTr(this.view.state, span, insertBefore);
      if (!tr) {
        logger.warn("block drag drop: rejected by block-selection", { span, insertBefore });
        return;
      }
      // 不 scrollIntoView：删除+插入后映射的选区常落在文档首尾，会导致滚动跳到顶部/底部
      this.view.dispatch(tr);
    } catch (err) {
      logger.warn("block drag drop failed", err);
    }
  }

  openBlockMenu(pos: number, node: PMNode) {
    const br = this.dragging?.dom.getBoundingClientRect() ?? this.view.dom.getBoundingClientRect();
    const span = this.dragging?.span ?? null;
    const payload: BlockMenuPayload = {
      pos,
      nodeType: node.type.name,
      nodeSize: node.nodeSize,
      x: br.left,
      y: br.top,
      editor: this.editor,
      count: span?.count ?? 1,
      from: span?.from ?? pos,
      to: span?.to ?? pos + node.nodeSize,
    };
    window.dispatchEvent(new CustomEvent<BlockMenuPayload>(BLOCK_MENU_EVENT, { detail: payload }));
  }

  onDragEnd() {
    if (this.dragging) {
      for (const d of this.dragging.doms) d.style.opacity = "";
    }
    this.dragging = null;
    this.clearDropTarget();
  }

  update() {
    const span = BLOCK_SELECTION_KEY.getState(this.view.state) ?? null;
    if (!span) {
      // 区间被外部改动（打字、撤销）清掉时，锚点坐标同样过期：留着它，下一次 Shift 点击
      // 会扩到一个已经不是当初那块的位置上
      this.anchor = null;
    }
    // 只在区间真的变了时重画：listTopBlocks 每个块都要读一次 getBoundingClientRect
    if (sameSpan(span, this.painted)) return;
    this.painted = span;
    for (const b of listTopBlocks(this.view)) {
      const on = !!span && b.pos >= span.from && b.pos < span.to;
      if (on) b.dom.setAttribute(SELECTED_ATTR, "true");
      else b.dom.removeAttribute(SELECTED_ATTR);
    }
  }

  destroy() {
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.handle.removeEventListener("mousedown", this.onHandleMouseDown);
    window.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("mouseup", this.onMouseUp, true);
    window.removeEventListener("scroll", this.onScroll, true);
    try {
      document.body.removeChild(this.handle);
      document.body.removeChild(this.dropIndicator);
    } catch {
      /* ignore */
    }
  }
}

export default BlockDrag;
