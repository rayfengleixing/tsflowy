/**
 * 浮动窗口边界约束：把 fixed 定位的浮层坐标 clamp 到编辑区可视矩形内，
 * 避免行详情窄面板 / 编辑区宽度调窄等场景下菜单飘出编辑区。
 * 编辑区滚动容器由 EditorPage 标记 data-editor-scroll（该容器 overflow-y-auto）。
 * 用到时先从 editor.view.dom 向上找该容器取其 getBoundingClientRect()。
 */
import type { Editor } from "@tiptap/core";

const PAD = 8;

/** 查找最近的可滚动编辑区容器（无则返回 viewport 矩形，作为兜底） */
function getEditorRect(editor: Editor | null | undefined): DOMRect | null {
  const dom = (editor?.view?.dom as HTMLElement | null) ?? null;
  const scroller = dom?.closest?.("[data-editor-scroll]");
  if (scroller) return scroller.getBoundingClientRect();
  return null;
}

/**
 * 把左上角为 (x,y)、尺寸为 (w,h) 的浮层 clamp 进编辑区可视矩形。
 * 返回 clamp 后的 (x,y)。若找不到容器则原样返回（保持旧行为，不越窗）。
 */
export function clampFloatToEditor(
  editor: Editor | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number } {
  const rect = getEditorRect(editor);
  if (!rect) return { x, y };
  const minX = rect.left + PAD;
  const maxX = rect.right - PAD - w;
  const minY = rect.top + PAD;
  const maxY = rect.bottom - PAD - h;
  const cx = Math.min(Math.max(x, minX), maxX);
  const cy = Math.min(Math.max(y, minY), maxY);
  return { x: cx, y: cy };
}

/** 仅水平 clamp（菜单往往只用水平方向修正，垂直交给自身逻辑） */
export function clampXToEditor(editor: Editor | null | undefined, x: number, w: number): number {
  const rect = getEditorRect(editor);
  if (!rect) return x;
  const minX = rect.left + PAD;
  const maxX = rect.right - PAD - w;
  return Math.min(Math.max(x, minX), maxX);
}
