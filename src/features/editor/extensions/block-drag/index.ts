// 块拖拽扩展（Phase 4.3 Block Drag）
//
// 实现方式：自定义 TipTap Extension（非 NodeView 方式），
//   - addOptions: 默认行为；
//   - addProseMirrorPlugins: 返回自定义 Plugin + PluginView，它会在 editor.view.dom 旁侧
//     挂一个 handle 容器（最小实现，直接写 DOM，不引入 React）。
//   - handle 仅显示在顶层块左侧（doc 直接子节点），支持两种交互：
//       · 按住拖动（mouse 事件链，不用 HTML5 drag——WebView2/自动化环境不可靠）→ 排序
//       · 单击 → 派发 BLOCK_MENU_EVENT，由 React 块菜单（block-menu.tsx）接管
//   - drop 只按"前/后"插入目标块相邻位置（不做精确坐标命中块内容中间），
//     避免 posAtCoords 在嵌入表格/数据库视图中产生的各种坑。
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { BLOCK_MENU_EVENT, type BlockMenuPayload } from "@/features/editor/block-menu";

const PLUGIN_KEY = new PluginKey<{ draggingDom: HTMLElement | null }>("block-drag");

const HANDLE_CLASS = "block-drag-handle";
const HANDLE_WIDTH = 20; // px，含 padding
/** 拖拽启动阈值（px） */
const DRAG_THRESHOLD = 5;
// 需要跳过的块（它们有自己的 drag handle，见 image/component.tsx）
const SKIP_BLOCK_TYPES = new Set(["image", "databaseView", "database_view", "imageGallery", "image-gallery"]);

/** 顶层块信息列表（按 DOM 顺序），用于根据鼠标 Y 计算 hover 目标。 */
function listTopBlocks(view: EditorView): { dom: HTMLElement; top: number; bottom: number; pos: number }[] {
  const docEl = view.dom;
  const rects: { dom: HTMLElement; top: number; bottom: number; pos: number }[] = [];
  for (let i = 0; i < docEl.children.length; i++) {
    const child = docEl.children[i] as HTMLElement;
    if (!child || child.nodeType !== 1) continue;
    if (SKIP_BLOCK_TYPES.has(child.getAttribute("data-node-type") ?? "")) continue;
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
    // 文档结构锁定块（首行 H1 标题 / 第二行分割线）：不显示手柄、不作为拖拽目标
    if (isProtectedStructureBlock(view, pos)) continue;
    rects.push({ dom: child, top: r.top, bottom: r.bottom, pos });
  }
  return rects;
}

/** 结构锁定块（首行 H1 标题 / 第二行分割线）不参与手柄显示/拖拽 */
function isProtectedStructureBlock(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  if (doc.childCount === 0) return false;
  const first = doc.child(0);
  if (pos === 0) {
    return first.type.name === "heading" && (first.attrs as { level: number }).level === 1;
  }
  if (doc.childCount < 2 || pos !== first.nodeSize) return false;
  const second = doc.child(1);
  return second.type.name === "horizontalRule";
}

export const BlockDrag = Extension.create({
  name: "blockDrag",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
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
          handleDOMEvents: {
            // 点击 handle 时确保不触发 editor 选区变化（handle 用 mousedown preventDefault 拦截）
          },
        },
      }),
    ];
  },
});

// ——————————————————————————————————————
// PluginView：handle DOM 管理 + 拖拽/点击事件
// ——————————————————————————————————————
class BlockDragView {
  handle: HTMLDivElement;
  view: EditorView;
  editor: Editor;
  /** 当前 hover 的顶层块 */
  hover: HTMLElement | null = null;
  /** 拖拽会话：按下点 + 源块信息（moved 表示已超过阈值进入拖拽） */
  dragging: { pos: number; node: PMNode; dom: HTMLElement; startX: number; startY: number; moved: boolean } | null =
    null;
  /** 拖拽目标：前/后 */
  dropTarget: { type: "before" | "after"; sibling: HTMLElement; pos: number } | null = null;
  dropIndicator: HTMLDivElement;
  /** 普通 hover 的 rAF 合并（mousemove 高频事件里全量扫描顶层块代价高） */
  private hoverRaf = 0;
  private lastHoverEvent: MouseEvent | null = null;

  constructor(view: EditorView, editor: Editor) {
    this.view = view;
    this.editor = editor;
    this.handle = document.createElement("div");
    this.handle.className = HANDLE_CLASS;
    this.handle.title = "拖动排序，点击编辑";
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
    this.dragging = { pos: info.pos, node, dom: blockDom, startX: e.clientX, startY: e.clientY, moved: false };
  };

  onMouseMove = (e: MouseEvent) => {
    if (this.dragging) {
      // 未超过阈值：仍是"潜在点击"，不进入拖拽
      if (!this.dragging.moved) {
        const dx = e.clientX - this.dragging.startX;
        const dy = e.clientY - this.dragging.startY;
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        this.dragging.moved = true;
        this.dragging.dom.style.opacity = "0.5";
        this.hideHandle();
      }
      this.updateDropTarget(e.clientY);
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
    if (target.dom.querySelector("[data-drag-handle]")) {
      this.hideHandle();
      return;
    }
    this.showHandle(target.dom);
  }

  onMouseUp = (_e: MouseEvent) => {
    if (!this.dragging) return;
    const session = this.dragging;
    if (session.moved) {
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
          sibling: b.dom,
          top: b.top - 1,
          left: b.dom.getBoundingClientRect().left,
          width: b.dom.getBoundingClientRect().width,
        };
        break;
      }
      if (i === blocks.length - 1) {
        target = {
          type: "after",
          pos: b.pos,
          sibling: b.dom,
          top: b.bottom - 1,
          left: b.dom.getBoundingClientRect().left,
          width: b.dom.getBoundingClientRect().width,
        };
      }
    }
    if (!target || !this.dragging) return;
    // 若目标就是源块 → 不显示指示
    if (target.sibling === this.dragging.dom) {
      this.clearDropTarget();
      return;
    }
    this.dropTarget = { type: target.type, sibling: target.sibling, pos: target.pos };
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
      const src = this.dragging.pos;
      const node = this.dragging.node;
      const tr = this.view.state.tr;
      const srcEnd = src + node.nodeSize;
      const slice = new Slice(Fragment.from(node), 0, 0);
      const isAfter = this.dropTarget.type === "after";

      // —— 关键修正（Phase 4 走查 P1#3）——
      // 先删再插后，目标块的 position 只在"源块位于目标块之前"时，
      // 且 dropTarget.type === "before" 时才会被左移 nodeSize：
      //   · before：targetPos 指向目标块起始，若该起始 > srcEnd（目标在删除段之后）→ 减 nodeSize
      //   · after：  targetPos 先变成目标块末尾；之后若目标块起始 > srcEnd → 末尾也要减 nodeSize
      // 即：after/before 两种情况的"是否偏移"依据，都是【目标块起始 pos 与 srcEnd 的关系】，
      // 而不是最终 targetPos 与 src 的大小关系。这避免了 after 下重复修正。
      const dropSiblingStart = this.dropTarget.pos;
      const shiftByDelete = srcEnd <= dropSiblingStart ? node.nodeSize : 0;

      let tr2 = tr.delete(src, srcEnd);
      let targetPos = dropSiblingStart - shiftByDelete;
      if (isAfter) {
        const remaining = tr2.doc.nodeAt(targetPos);
        if (remaining) {
          targetPos += remaining.nodeSize;
        } else {
          // fallback：若目标块不存在（极端情况），插入文档末尾
          targetPos = Math.max(0, tr2.doc.content.size - 1);
        }
      }
      tr2 = tr2.insert(targetPos, slice.content);
      // 不 scrollIntoView：删除+插入后映射的选区常落在文档首尾，会导致滚动跳到顶部/底部
      this.view.dispatch(tr2);
    } catch (err) {
      console.warn("block drag drop failed", err);
    }
  }

  openBlockMenu(pos: number, node: PMNode) {
    const br = this.dragging?.dom.getBoundingClientRect() ?? this.view.dom.getBoundingClientRect();
    const payload: BlockMenuPayload = {
      pos,
      nodeType: node.type.name,
      nodeSize: node.nodeSize,
      x: br.left,
      y: br.top,
      editor: this.editor,
    };
    window.dispatchEvent(new CustomEvent<BlockMenuPayload>(BLOCK_MENU_EVENT, { detail: payload }));
  }

  onDragEnd() {
    if (this.dragging) this.dragging.dom.style.opacity = "";
    this.dragging = null;
    this.clearDropTarget();
  }

  update() {
    /* 不需要处理 state 变化 */
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
