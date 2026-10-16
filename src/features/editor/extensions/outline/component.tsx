import { useEffect, useMemo, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X, List } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";

/** 与 LockedHeading 的 levels 同口径（EditorPage 装配）：改动上限时两边都要跟着 */
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
const MAX_HEADING_LEVEL: HeadingLevel = 6;

interface HeadingEntry {
  pos: number; // 文档中的绝对 position（0-based，node start）
  level: HeadingLevel;
  text: string;
}

/** 库里可能存着别的编辑器写来的越界级别：夹回 1-6，别让 Record 取到 undefined */
function clampLevel(lvl: number): HeadingLevel {
  const n = Math.round(lvl);
  if (!Number.isFinite(n) || n < 1) return 1;
  return (n > MAX_HEADING_LEVEL ? MAX_HEADING_LEVEL : n) as HeadingLevel;
}

/** 每级缩进一档（步进 16px），4 级起字号收回一档：目录块本身不该比正文更抢眼 */
const LEVEL_CLASS: Record<HeadingLevel, string> = {
  1: "pl-2 font-semibold text-neutral-800",
  2: "pl-6 text-neutral-700",
  3: "pl-10 text-[12.5px] text-neutral-600",
  4: "pl-14 text-[12px] text-neutral-600",
  5: "pl-[72px] text-[12px] text-neutral-500",
  6: "pl-[88px] text-[12px] text-neutral-500",
};

function collectHeadings(editor: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name === "heading") {
      const lvl = (node.attrs.level as number | undefined) ?? 1;
      result.push({ pos, level: clampLevel(lvl), text: node.textContent.trim() });
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
                LEVEL_CLASS[h.level],
              )}
            >
              <span className="w-5 shrink-0 text-neutral-400">H{h.level}</span>
              <span className="min-w-0 truncate">
                {h.text || (
                  <em className="text-neutral-300">{t("outline.untitled", { level: t(`outline.h${h.level}`) })}</em>
                )}
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <p className="py-4 text-center text-[13px] text-neutral-400">{t("outline.empty")}</p>
      )}
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/outline:flex"
        title={t("outline.delete")}
        onClick={() => deleteNode()}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
