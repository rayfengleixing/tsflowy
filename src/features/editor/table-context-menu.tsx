import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { t } from "@/lib/i18n";

const CELL_TYPES = ["tableCell", "tableHeader"];

/** 表格右键菜单：添加/删除行、列与删除整个表格（项目说明书 6.3 表格块） */
export function TableContextMenu({ editor }: { editor: Editor | null }) {
  const [raw, setRaw] = useState<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // 右键表格单元格 → 定位选择到该单元格并弹出菜单
  useEffect(() => {
    const dom = editor?.view?.dom;
    if (!dom) return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest?.("table")) return; // 非表格区域交给系统默认行为
      event.preventDefault();
      // 将 ProseMirror 选择定位到被右键的单元格，确保增删命令作用于该单元格
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (at) {
        const $pos = editor.state.doc.resolve(at.pos);
        let d = $pos.depth;
        while (d >= 0 && !CELL_TYPES.includes($pos.node(d).type.name)) d--;
        if (d >= 0) {
          const cellPos = $pos.before(d);
          editor.chain().setCellSelection({ anchorCell: cellPos, headCell: cellPos }).run();
        }
      }
      setRaw({ x: event.clientX, y: event.clientY });
    };
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [editor]);

  // 打开后校正坐标，避免超出视口
  useLayoutEffect(() => {
    if (!raw) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = raw.x;
    let y = raw.y;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    setPos({ x, y });
  }, [raw]);

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
  const itemCls = "flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-neutral-100";
  const divider = <div className="my-1 h-px bg-neutral-100" />;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[120] min-w-[170px] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
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
      <button className={`${itemCls} text-red-600 hover:bg-red-50`} onClick={run(() => editor.chain().focus().deleteTable().run())}>
        {t("table.deleteTable")}
      </button>
    </div>,
    document.body,
  );
}
