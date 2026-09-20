import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import type { CalloutColor } from "./node";
import { EMOJIS } from "@/components/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COLOR_TOKENS: Record<CalloutColor, { bar: string; bg: string; border: string; name: string; dot: string }> = {
  blue: {
    bar: "bg-blue-400",
    bg: "bg-blue-50",
    border: "border-blue-200",
    name: t("callout.colorBlue"),
    dot: "bg-blue-500",
  },
  green: {
    bar: "bg-green-400",
    bg: "bg-green-50",
    border: "border-green-200",
    name: t("callout.colorGreen"),
    dot: "bg-green-500",
  },
  orange: {
    bar: "bg-orange-400",
    bg: "bg-orange-50",
    border: "border-orange-200",
    name: t("callout.colorOrange"),
    dot: "bg-orange-500",
  },
  red: { bar: "bg-red-400", bg: "bg-red-50", border: "border-red-200", name: t("callout.colorRed"), dot: "bg-red-500" },
  purple: {
    bar: "bg-purple-400",
    bg: "bg-purple-50",
    border: "border-purple-200",
    name: t("callout.colorPurple"),
    dot: "bg-purple-500",
  },
  yellow: {
    bar: "bg-yellow-400",
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    name: t("callout.colorYellow"),
    dot: "bg-yellow-500",
  },
};

const COLORS = Object.keys(COLOR_TOKENS) as CalloutColor[];

/**
 * Callout（提示框）组件：
 *  - emoji 与内容：第一行 inline-flex，emoji 大小与文字（~16px/24px行高）匹配，vertical center 对齐
 *  - 颜色选择：合并进 emoji 选择菜单中（菜单底部横排 6 色圆点），整体 1 个 Popover 触发按钮
 *  - Popover 使用 createPortal，绝不会撑开 callout 本身高度
 */
export function CalloutNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const emoji = (node.attrs.emoji as string) ?? "💡";
  const color = (node.attrs.color as CalloutColor) ?? "blue";
  const tokens = COLOR_TOKENS[color] ?? COLOR_TOKENS.blue;

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/callout relative my-3 rounded-lg border p-3",
        tokens.bg,
        tokens.border,
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className="flex items-start gap-3">
        {/* 左侧竖条 + emoji + 选择按钮（一行内，大小与正文第一行文字一致） */}
        <div className={cn("w-1 shrink-0 self-stretch rounded-full", tokens.bar)} />
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="-my-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-base leading-none hover:bg-white/70"
              title={t("callout.changeIcon")}
              onMouseDown={(e) => e.preventDefault()}
              style={{ fontSize: "18px", lineHeight: 1 }}
            >
              {emoji}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" side="right" sideOffset={6} className="w-auto p-2">
            {/* 上半部分：emoji 选择 */}
            <div className="mb-1.5 border-b border-neutral-200 pb-1.5">
              <div className="mb-1 px-0.5 text-[11px] uppercase tracking-wide text-neutral-400">
                {t("callout.changeIcon")}
              </div>
              <div className="grid grid-cols-6 gap-1">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded text-lg hover:bg-neutral-200",
                      emoji === e && "bg-brand-50 ring-1 ring-brand-500",
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      updateAttributes({ emoji: e });
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            {/* 下半部分：颜色圆点横排（与 emoji 共用菜单） */}
            <div>
              <div className="mb-1 px-0.5 text-[11px] uppercase tracking-wide text-neutral-400">
                {t("callout.changeColor")}
              </div>
              <div className="flex items-center gap-1.5 px-1">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={COLOR_TOKENS[c].name}
                    className={cn(
                      "h-6 w-6 rounded-full border border-neutral-200 hover:scale-110 transition",
                      COLOR_TOKENS[c].dot,
                      color === c && "ring-2 ring-brand-500 ring-offset-1",
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      updateAttributes({ color: c });
                    }}
                  />
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <div className="min-w-0 flex-1 pt-0">
          <NodeViewContent className="ProseMirror-callout-content [&>p:first-child]:leading-6 [&>p:first-child]:py-0 [&>p:first-child]:my-0 [&>p:first-child]:text-[15px]" />
        </div>
      </div>
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/callout:flex"
        title={t("callout.delete")}
        onClick={() => deleteNode()}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
