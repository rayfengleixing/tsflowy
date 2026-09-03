import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Palette, X } from "lucide-react";
import type { CalloutColor } from "./node";
import { EMOJIS } from "@/components/emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COLOR_TOKENS: Record<CalloutColor, { bar: string; bg: string; border: string; name: string; dot: string }> = {
  blue:   { bar: "bg-blue-400",    bg: "bg-blue-50",    border: "border-blue-200",    name: t("callout.colorBlue"),   dot: "bg-blue-500" },
  green:  { bar: "bg-green-400",   bg: "bg-green-50",   border: "border-green-200",   name: t("callout.colorGreen"),  dot: "bg-green-500" },
  orange: { bar: "bg-orange-400",  bg: "bg-orange-50",  border: "border-orange-200",  name: t("callout.colorOrange"), dot: "bg-orange-500" },
  red:    { bar: "bg-red-400",     bg: "bg-red-50",     border: "border-red-200",     name: t("callout.colorRed"),    dot: "bg-red-500" },
  purple: { bar: "bg-purple-400",  bg: "bg-purple-50",  border: "border-purple-200",  name: t("callout.colorPurple"), dot: "bg-purple-500" },
  yellow: { bar: "bg-yellow-400",  bg: "bg-yellow-50",  border: "border-yellow-200",  name: t("callout.colorYellow"), dot: "bg-yellow-500" },
};

const COLORS = Object.keys(COLOR_TOKENS) as CalloutColor[];

/**
 * Callout 组件重写（M6 修复 2）：
 *  - emoji 选择：用 shadcn Popover（内部 createPortal 到 body），绝对不会撑开 callout
 *  - 颜色选择：由"左侧竖排 6 个圆点 inline"改为 1 个 Palette 按钮 → Popover 浮层选色（不占 callout 垂直高度）
 *  - 避免经验 1508571 的问题：Popover 内部 outside-click 已做 trigger+content 的白名单，不会点选即关闭
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
        "group/callout relative my-3 flex gap-2 rounded-lg border p-3",
        tokens.bg,
        tokens.border,
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className={cn("w-1 shrink-0 rounded-full", tokens.bar)} />
      {/* 左侧 1 列：emoji + palette 两个工具按钮（Popover 弹出，本身只占 h-8 两行） */}
      <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="flex h-8 w-8 items-center justify-center rounded text-2xl hover:bg-white/70"
              title={t("callout.changeIcon")}
              onMouseDown={(e) => e.preventDefault()}
            >
              {emoji}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="right" sideOffset={6} className="w-auto p-2">
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
          </PopoverContent>
        </Popover>

        {/* 6 个主题色切换：1 个 Palette 按钮 → Popover 浮层横排 6 色 dot（绝对不占 callout 内高度） */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-neutral-600 hover:bg-white/70"
              title={t("callout.changeColor")}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="right" sideOffset={6} className="w-auto p-2">
            <div className="flex items-center gap-1.5">
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
          </PopoverContent>
        </Popover>
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
