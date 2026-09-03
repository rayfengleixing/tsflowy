import { useState } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import type { CalloutColor } from "./node";
import { EmojiPicker, EMOJIS } from "@/components/emoji-picker";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COLOR_TOKENS: Record<CalloutColor, { bar: string; bg: string; border: string; name: string }> = {
  blue:   { bar: "bg-blue-400",    bg: "bg-blue-50",    border: "border-blue-200",    name: t("callout.colorBlue") },
  green:  { bar: "bg-green-400",   bg: "bg-green-50",   border: "border-green-200",   name: t("callout.colorGreen") },
  orange: { bar: "bg-orange-400",  bg: "bg-orange-50",  border: "border-orange-200",  name: t("callout.colorOrange") },
  red:    { bar: "bg-red-400",     bg: "bg-red-50",     border: "border-red-200",     name: t("callout.colorRed") },
  purple: { bar: "bg-purple-400",  bg: "bg-purple-50",  border: "border-purple-200",  name: t("callout.colorPurple") },
  yellow: { bar: "bg-yellow-400",  bg: "bg-yellow-50",  border: "border-yellow-200",  name: t("callout.colorYellow") },
};

const COLORS = Object.keys(COLOR_TOKENS) as CalloutColor[];

export function CalloutNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const emoji = (node.attrs.emoji as string) ?? "💡";
  const color = (node.attrs.color as CalloutColor) ?? "blue";
  const tokens = COLOR_TOKENS[color] ?? COLOR_TOKENS.blue;
  const [showEmojiGrid, setShowEmojiGrid] = useState(false);

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/callout relative my-3 flex gap-2 rounded-lg border p-3",
        tokens.bg,
        tokens.border,
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className={cn("w-1 shrink-0 rounded-full", tokens.bar)} />
      <div className="relative flex shrink-0 flex-col items-center gap-2 pt-1">
        <button
          className="flex h-8 w-8 items-center justify-center rounded text-2xl hover:bg-white/70"
          title={t("callout.changeIcon")}
          onClick={() => setShowEmojiGrid((v) => !v)}
        >
          {emoji}
        </button>
        {showEmojiGrid && (
          <div
            className="absolute left-10 top-0 z-40 w-56 rounded-lg border border-neutral-300 bg-white p-2 shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="grid grid-cols-6 gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  className="flex h-7 w-7 items-center justify-center rounded text-lg hover:bg-neutral-200"
                  onClick={() => { updateAttributes({ emoji: e }); setShowEmojiGrid(false); }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 6 色切换条 */}
        <div className="mt-2 flex flex-col gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              title={COLOR_TOKENS[c].name}
              className={cn(
                "h-4 w-4 rounded-full border border-neutral-200 hover:scale-110 transition",
                COLOR_TOKENS[c].bar,
                color === c && "ring-2 ring-brand-500 ring-offset-1",
              )}
              onClick={() => updateAttributes({ color: c })}
            />
          ))}
        </div>
        <div style={{ display: "none" }}>
          <EmojiPicker value={emoji} onChange={(e) => updateAttributes({ emoji: e ?? "💡" })} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <NodeViewContent className="ProseMirror-callout-content" />
      </div>
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/callout:flex"
        title="删除提示框"
        onClick={() => deleteNode()}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
