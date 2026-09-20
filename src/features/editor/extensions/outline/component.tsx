import { useEffect, useMemo, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X, List } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";

interface HeadingEntry {
  pos: number; // 文档中的绝对 position（0-based，node start）
  level: 1 | 2 | 3;
  text: string;
}

function collectHeadings(editor: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name === "heading") {
      const lvl = (node.attrs.level as number) ?? 1;
      const level = (lvl >= 3 ? 3 : lvl <= 1 ? 1 : lvl) as 1 | 2 | 3;
      result.push({ pos, level, text: node.textContent?.trim() ?? "" });
    }
    return undefined;
  });
  return result;
}

export function OutlineNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { editor, deleteNode, selected } = props;
  const [headings, setHeadings] = useState<HeadingEntry[]>(() => collectHeadings(editor));
  const lastSigRef = useRef<string>("");

  useEffect(() => {
    // 编辑内容或选区变化时，按需刷新（比较字符串签名节流）
    const handler = () => {
      const list = collectHeadings(editor);
      const sig = list.map((h) => `${h.level}:${h.pos}:${h.text}`).join("|");
      if (sig !== lastSigRef.current) {
        lastSigRef.current = sig;
        setHeadings(list);
      }
    };
    editor.on("update", handler);
    editor.on("selectionUpdate", handler);
    handler();
    return () => {
      editor.off("update", handler);
      editor.off("selectionUpdate", handler);
    };
  }, [editor]);

  const scrollToItem = (entry: HeadingEntry) => {
    try {
      editor.chain().focus().setTextSelection(entry.pos).run();
      // DOM 滚动：找到 outline nodeview 本身的 wrapper 位置，滚动祖先使其可见
      // 更简单：set selection 后 editor view 会让 selection 的 from 位置可见（scrollIntoView 默认）
      window.requestAnimationFrame(() => {
        const domAtPos = editor.view.domAtPos(entry.pos + 1); // +1 skip position inside heading
        const target = (domAtPos.node as HTMLElement | null)?.parentElement ?? (domAtPos.node as HTMLElement | null);
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } catch (e) {
      logger.error("outline scrollTo failed", e);
    }
  };

  const hasData = useMemo(() => headings.length > 0, [headings]);

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/outline relative my-3 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3",
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[12px] text-neutral-500">
        <List className="h-3.5 w-3.5" />
        <span>{t("slash.outline")}</span>
      </div>
      {hasData ? (
        <nav className="flex flex-col gap-1">
          {headings.map((h, i) => (
            <button
              key={`${h.pos}-${i}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => scrollToItem(h)}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-brand-100",
                h.level === 1 && "pl-2 font-semibold text-neutral-800",
                h.level === 2 && "pl-6 text-neutral-700",
                h.level === 3 && "pl-10 text-[12.5px] text-neutral-600",
              )}
            >
              <span className="w-4 shrink-0 text-neutral-400">
                {h.level === 1 ? "H1" : h.level === 2 ? "H2" : "H3"}
              </span>
              <span className="min-w-0 truncate">
                {h.text || <em className="text-neutral-300">(未命名 {t(`outline.h${h.level}`)})</em>}
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <p className="py-4 text-center text-[13px] text-neutral-400">{t("outline.empty")}</p>
      )}
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/outline:flex"
        title="删除目录"
        onClick={() => deleteNode()}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
