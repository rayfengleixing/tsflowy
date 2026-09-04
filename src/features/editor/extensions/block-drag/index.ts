// 块拖拽扩展（Phase 4.3 Block Drag）
//
// 实现方式：自定义 TipTap Extension（非 NodeView 方式），
//   - addOptions: 默认行为；
//   - addProseMirrorPlugins: 返回自定义 Plugin + PluginView，它会在 editor.view.dom 旁侧
//     挂一个 React 渲染的 handle 容器（这里为最小实现不走 React 也不引入 react-dom/client，直接写 DOM）。
//   - handle 仅显示在顶层块左侧（blockGroup/doc 直接子节点），点击可拖拽，drop 时计算位置并执行 tr。
//
// 简化（plan 风险备选 B）：drop 只按"前/后"插入目标块相邻位置（不做精确坐标命中块内容中间），
//   避免 posAtCoords 在嵌入表格/数据库视图中产生的各种坑。
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";

const PLUGIN_KEY = new PluginKey<{ draggingDom: HTMLElement | null }>("block-drag");

const HANDLE_CLASS = "block-drag-handle";
const HANDLE_WIDTH = 20; // px，含 padding
// 需要跳过的块（它们有自己的 drag handle，见 image/component.tsx）
const SKIP_BLOCK_TYPES = new Set([
  "image",
  "databaseView",
  "database_view",
  "imageGallery",
  "image-gallery",
]);

/** 顶层块信息列表（按 DOM 顺序），用于根据鼠标 Y 计算 hover 目标。 */
function listTopBlocks(view: EditorView): { dom: HTMLElement; top: number; bottom: number; pos: number }[] {
  const docEl = view.dom as HTMLElement;
  const rects: { dom: HTMLElement; top: number; bottom: number; pos: number }[] = [];
  for (let i = 0; i < docEl.children.length; i++) {
    const child = docEl.children[i] as HTMLElement;
    if (!child || child.nodeType !== 1) continue;
    if (SKIP_BLOCK_TYPES.has(child.getAttribute("data-node-type") ?? "")) continue;
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const center = { left: r.left + Math.max(r.width / 2, 10), top: r.top + 4 };
    const posRes = view.posAtCoords(center);
    if (!posRes) continue;
    const $ = view.state.doc.resolve(posRes.pos);
    const pos = $.depth >= 1 ? $.before(Math.min($.depth, 1)) : $.pos;
    rects.push({ dom: child, top: r.top, bottom: r.bottom, pos });
  }
  return rects;
}

export const BlockDrag = Extension.create({
  name: "blockDrag",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        view(view) {
          return new BlockDragView(view);
        },
        state: {
          init: () => ({ draggingDom: null }),
          apply: (_tr, prev) => prev,
        },
        props: {
          handleDOMEvents: {
            // 点击 handle 时确保不触发 editor 选区变化（handle 用 draggable + dragstart 拦截）
          },
        },
      }),
    ];
  },
});

// ——————————————————————————————————————
// PluginView：handle DOM 管理 + 拖拽事件
// ——————————————————————————————————————
class BlockDragView {
  handle: HTMLDivElement;
  view: EditorView;
  /** 当前 hover 的顶层块 */
  hover: HTMLElement | null = null;
  /** 拖拽源块信息 */
  dragging: { pos: number; node: PMNode; dom: HTMLElement } | null = null;
  /** 拖拽目标：前/后 */
  dropTarget: { type: "before" | "after"; sibling: HTMLElement; pos: number } | null = null;
  dropIndicator: HTMLDivElement;

  constructor(view: EditorView) {
    this.view = view;
    this.handle = document.createElement("div");
    this.handle.className = HANDLE_CLASS;
    this.handle.setAttribute("draggable", "true");
    this.handle.title = "拖动移动块";
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

    // 事件绑定
    this.handle.addEventListener("dragstart", this.onDragStart);
    this.handle.addEventListener("dragend", this.onDragEnd);
    window.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("scroll", this.onScroll, true);
    document.addEventListener("dragover", this.onDragOver);
    document.addEventListener("drop", this.onDrop, true);
  }

  onMouseMove = (e: MouseEvent) => {
    if (this.dragging) return; // 拖拽中保持 handle 位置不变
    const root = (this.view.dom as HTMLElement).getBoundingClientRect();
    // 仅在 editor 范围内显示
    if (e.clientX < root.left - 60 || e.clientX > root.right + 10 ||
        e.clientY < root.top - 10 || e.clientY > root.bottom + 10) {
      this.hideHandle();
      return;
    }
    // 找到鼠标所在行的顶层块
    const blocks = listTopBlocks(this.view);
    let target: typeof blocks[number] | null = null;
    for (const b of blocks) {
      if (e.clientY >= b.top - 2 && e.clientY < b.bottom + 2) {
        target = b; break;
      }
    }
    if (!target) {
      this.hideHandle();
      return;
    }
    // 跳过已用自己 handle 的块类型（根据 data-drag-handle 标记）
    if (target.dom.querySelector("[data-drag-handle]")) {
      this.hideHandle();
      return;
    }
    this.showHandle(target.dom);
  };

  onScroll = () => {
    // 滚动时隐藏 handle（下次 mousemove 再重新定位）
    this.hideHandle();
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

  onDragStart = (e: DragEvent) => {
    const blockDom: HTMLElement | null =
      (this.handle as HTMLElement & { _blockDom?: HTMLElement })._blockDom ?? null;
    if (!blockDom) return;
    // 找到块在 doc 中的 pos
    const blocks = listTopBlocks(this.view);
    const info = blocks.find((b) => b.dom === blockDom);
    if (!info) return;
    const node = this.view.state.doc.nodeAt(info.pos);
    if (!node) return;
    this.dragging = { pos: info.pos, node, dom: blockDom };
    this.hideHandle();
    blockDom.style.opacity = "0.5";
    try {
      // 自定义数据类型+文本
      e.dataTransfer?.setData("text/block-drag-pos", String(info.pos));
      e.dataTransfer?.setData("text/plain", String(info.pos));
      // 使用块 DOM 快照作拖拽图像（视觉更佳）
      if (blockDom instanceof Element && e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
    } catch { /* ignore */ }
  };

  onDragEnd = () => {
    if (this.dragging) this.dragging.dom.style.opacity = "";
    this.dragging = null;
    this.clearDropTarget();
  };

  onDragOver = (e: DragEvent) => {
    if (!this.dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const blocks = listTopBlocks(this.view);
    const y = e.clientY;
    let target: { type: "before" | "after"; pos: number; sibling: HTMLElement; top: number; left: number; width: number } | null = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const mid = (b.top + b.bottom) / 2;
      if (y < mid) {
        // 插到这个块之前
        target = { type: "before", pos: b.pos, sibling: b.dom, top: b.top - 1, left: b.dom.getBoundingClientRect().left, width: b.dom.getBoundingClientRect().width };
        break;
      }
      // 最后一个块下半区 → 插到后面
      if (i === blocks.length - 1) {
        target = { type: "after", pos: b.pos, sibling: b.dom, top: b.bottom - 1, left: b.dom.getBoundingClientRect().left, width: b.dom.getBoundingClientRect().width };
      }
    }
    if (!target) return;
    // 若目标就是源块 → 不显示指示
    const src = this.dragging.dom;
    if (target.sibling === src) { this.clearDropTarget(); return; }
    this.dropTarget = { type: target.type, sibling: target.sibling, pos: target.pos };
    // 显示蓝色指示条
    this.dropIndicator.style.display = "block";
    this.dropIndicator.style.top = `${target.top}px`;
    this.dropIndicator.style.left = `${target.left}px`;
    this.dropIndicator.style.width = `${target.width}px`;
  };

  clearDropTarget() {
    this.dropTarget = null;
    this.dropIndicator.style.display = "none";
  }

  onDrop = (e: DragEvent) => {
    if (!this.dragging || !this.dropTarget) return;
    // 只有在 editor DOM 内放下才处理
    const editorRoot = this.view.dom as HTMLElement;
    if (!editorRoot.contains(e.target as Node | null) &&
        !editorRoot.contains((e.target as HTMLElement | null)?.closest?.(".ProseMirror") as HTMLElement | null)) {
      // 忽略 editor 之外的 drop（可能交给浏览器默认行为）
      return;
    }
    e.preventDefault();
    e.stopPropagation();
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
      // 根据 before/after 计算插入位置
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
      this.view.dispatch(tr2.scrollIntoView());
    } catch (err) {
      console.warn("block drag drop failed", err);
    } finally {
      this.onDragEnd();
    }
  };

  update() { /* 不需要处理 state 变化 */ }

  destroy() {
    document.removeEventListener("dragover", this.onDragOver);
    document.removeEventListener("drop", this.onDrop, true);
    window.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("scroll", this.onScroll, true);
    this.handle.removeEventListener("dragstart", this.onDragStart);
    this.handle.removeEventListener("dragend", this.onDragEnd);
    try {
      document.body.removeChild(this.handle);
      document.body.removeChild(this.dropIndicator);
    } catch { /* ignore */ }
  }
}

export default BlockDrag;
