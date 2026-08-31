import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Check,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Pilcrow,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const COLORS = ["#00B5FF", "#FF5C5C", "#FFB020", "#4CAF50", "#9747FF", "#3D404F", "#FF8FAB"];

function ToolButton(props: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={props.title}
      className={cn(
        "flex h-6 min-w-6 items-center justify-center rounded px-1 text-neutral-600 hover:bg-neutral-200",
        props.active && "bg-brand-100 text-brand-600",
      )}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

interface ToolbarSnapshot {
  visible: boolean;
  top: number;
  left: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  highlight: boolean;
  color: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

function snapshot(editor: Editor): ToolbarSnapshot {
  const { from, to, empty } = editor.state.selection;
  const isText = editor.state.selection instanceof TextSelection;
  const visible = isText && !empty && from !== to;
  let top = 0;
  let left = 0;
  if (visible) {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    top = Math.min(start.top, end.top);
    left = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
  }
  return {
    visible,
    top,
    left,
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    highlight: editor.isActive("highlight"),
    color: (editor.getAttributes("textStyle").color as string | null) ?? null,
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };
}

/** 选中文本浮动工具栏（项目说明书 8.3）：粗/斜/下划线/删除线/行内代码/高亮/颜色/链接/撤销重做 */
export function FloatingToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [colorOpen, setColorOpen] = useState(false);
  const [, bump] = useState(0);

  const state = useEditorState({ editor, selector: ({ editor }) => snapshot(editor) });

  // 滚动时刷新位置（编辑器容器滚动/窗口滚动）
  useEffect(() => {
    const onScroll = () => bump((n) => n + 1);
    const container = editor.view.dom.closest(".overflow-y-auto") ?? editor.view.dom.parentElement;
    window.addEventListener("scroll", onScroll, true);
    container?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      container?.removeEventListener("scroll", onScroll);
    };
  }, [editor]);

  const applyLink = () => {
    const href = linkValue.trim();
    if (href) {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
    setLinkValue("");
  };

  if (!state.visible) return null;

  const menuWidth = 300;
  const left = Math.min(Math.max(state.left - menuWidth / 2, 8), Math.max(window.innerWidth - menuWidth - 8, 8));
  const top = Math.max(state.top - 46, 8);

  return createPortal(
    <div
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-neutral-300 bg-white px-1.5 py-1 shadow-lg"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <ToolButton title={t("float.undo")} disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className={cn("h-3.5 w-3.5", !state.canUndo && "opacity-30")} />
      </ToolButton>
      <ToolButton title={t("float.redo")} disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className={cn("h-3.5 w-3.5", !state.canRedo && "opacity-30")} />
      </ToolButton>
      <div className="mx-0.5 h-4 w-px bg-neutral-300" />
      <ToolButton title={t("float.bold")} active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("float.italic")} active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        title={t("float.underline")}
        active={state.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("float.strike")} active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title={t("float.code")} active={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Pilcrow className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        title={t("float.highlight")}
        active={state.highlight}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
      >
        <Highlighter className="h-3.5 w-3.5" />
      </ToolButton>

      {/* 文字颜色 */}
      <div className="relative">
        <ToolButton title={t("float.color")} active={!!state.color} onClick={() => setColorOpen((v) => !v)}>
          <span
            className="block h-3 w-3 rounded-full border border-neutral-300"
            style={{ background: state.color ?? "#3D404F" }}
          />
        </ToolButton>
        {colorOpen && (
          <div className="absolute right-0 top-8 z-50 flex gap-1 rounded-lg border border-neutral-300 bg-white p-1.5 shadow-lg">
            {COLORS.map((c) => (
              <button
                key={c}
                className="h-5 w-5 rounded-full border border-neutral-200 hover:scale-110"
                style={{ background: c }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().setColor(c).run();
                  setColorOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 链接 */}
      <div className="relative">
        <ToolButton
          title={t("float.link")}
          active={editor.isActive("link")}
          onClick={() => {
            const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
            setLinkValue(prev);
            setLinkOpen((v) => !v);
          }}
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolButton>
        {linkOpen && (
          <div className="absolute right-0 top-8 z-50 flex items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1.5 shadow-lg">
            <input
              autoFocus
              className="h-6 w-44 rounded border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
              placeholder={t("float.linkPlaceholder")}
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyLink();
                if (e.key === "Escape") setLinkOpen(false);
              }}
            />
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-200"
              onMouseDown={(e) => e.preventDefault()}
              onClick={applyLink}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-200"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().unsetLink().run();
                setLinkOpen(false);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="mx-0.5 h-4 w-px bg-neutral-300" />
      <ToolButton
        title={t("float.clearFormat")}
        onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
      >
        <RemoveFormatting className="h-3.5 w-3.5" />
      </ToolButton>
    </div>,
    document.body,
  );
}
