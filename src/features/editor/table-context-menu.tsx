import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { t } from "@/lib/i18n";
import { clampFloatToEditor } from "./float-clamp";

const CELL_TYPES = ["tableCell", "tableHeader"];

/** 打开菜单时算好合并/拆分是否可用：库里的 mergeCells/splitCell 自己判定几何是否合法，
 *  这里只做「能不能」的探测（can 模式不会派发事务），不给用户点了没反应的按钮 */
function mergeChoices(editor: Editor) {
  return {
    canMerge: editor.can().chain().focus().mergeCells().run(),
    canSplit: editor.can().chain().focus().splitCell().run(),
  };
}

/** 表格右键菜单：添加/删除行、列，合并/拆分单元格与删除整个表格（项目说明书 6.3 表格块） */
export function TableContextMenu({ editor }: { editor: Editor | null }) {
  const [raw, setRaw] = useState<{ x: number; y: number; canMerge: boolean; canSplit: boolean } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // 右键表格单元格 → 定位选择到该单元格并弹出菜单
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("table")) return; // 非表格区域交给系统默认行为
      // 坐标→文档位置：必须真的落在 tableCell/tableHeader 内才算命中。
      // databaseView 渲染的也是 <table>，closest 拦不住它；不校验单元格的话，
      // 右键数据库网格会弹出编辑器表格菜单，且未选单元格时增删命令作用到别处。
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      let cellPos = -1;
      if (at) {
        const $pos = editor.state.doc.resolve(at.pos);
        for (let d = $pos.depth; d >= 0; d--) {
          if (CELL_TYPES.includes($pos.node(d).type.name)) {
            cellPos = $pos.before(d);
            break;
          }
        }
      }
      if (cellPos < 0) return;
      event.preventDefault();
      // 已经框选了多个单元格（按住拖动格子形成的 CellSelection）且右键落在其中：
      // 保留整片选择，否则「拖选一片 → 右键 → 合并」这条路会被这一步压成单格而永远合不了。
      const sel = editor.state.selection;
      const inExistingRange =
        sel instanceof CellSelection &&
        (() => {
          let hit = false;
          sel.forEachCell((_node, p) => {
            if (p === cellPos) hit = true;
          });
          return hit;
        })();
      if (!inExistingRange) {
        // 将 ProseMirror 选择定位到被右键的单元格，确保增删命令作用于该单元格
        editor.chain().setCellSelection({ anchorCell: cellPos, headCell: cellPos }).run();
      }
      setRaw({ x: event.clientX, y: event.clientY, ...mergeChoices(editor) });
    };
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [editor]);

  // 打开后校正坐标：整体 clamp 进编辑区可视矩形内（不超出编辑区，也不超出窗口）
  useLayoutEffect(() => {
    if (!raw || !editor) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (!w || !h) return;
    const clamped = clampFloatToEditor(editor, raw.x, raw.y, w, h);
    setPos({ x: clamped.x, y: clamped.y });
  }, [raw, editor]);

  // 关闭：点击别处 / Esc / 滚动
  useEffect(() => {
    if (!raw) return;
    const close = () => setRaw(null);
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [raw]);

  if (!raw || !editor) return null;

  const run = (fn: () => void) => () => {
    fn();
    setRaw(null);
  };
  const itemCls =
    "flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-neutral-100";
  const divider = <div className="my-1 h-px bg-neutral-100" />;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[120] min-w-[170px] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {raw.canMerge && (
        <button className={itemCls} onClick={run(() => editor.chain().focus().mergeCells().run())}>
          {t("table.mergeCells")}
        </button>
      )}
      {raw.canSplit && (
        <button className={itemCls} onClick={run(() => editor.chain().focus().splitCell().run())}>
          {t("table.splitCell")}
        </button>
      )}
      {(raw.canMerge || raw.canSplit) && divider}
      <button className={itemCls} onClick={run(() => editor.chain().focus().addRowBefore().run())}>
        {t("table.addRowAbove")}
      </button>
      <button className={itemCls} onClick={run(() => editor.chain().focus().addRowAfter().run())}>
        {t("table.addRowBelow")}
      </button>
      {divider}
      <button className={itemCls} onClick={run(() => editor.chain().focus().addColumnBefore().run())}>
        {t("table.addColumnLeft")}
      </button>
      <button className={itemCls} onClick={run(() => editor.chain().focus().addColumnAfter().run())}>
        {t("table.addColumnRight")}
      </button>
      {divider}
      <button className={itemCls} onClick={run(() => editor.chain().focus().deleteRow().run())}>
        {t("table.deleteRow")}
      </button>
      <button className={itemCls} onClick={run(() => editor.chain().focus().deleteColumn().run())}>
        {t("table.deleteColumn")}
      </button>
      {divider}
      <button
        className={`${itemCls} text-red-600 hover:bg-red-50`}
        onClick={run(() => editor.chain().focus().deleteTable().run())}
      >
        {t("table.deleteTable")}
      </button>
    </div>,
    document.body,
  );
}
