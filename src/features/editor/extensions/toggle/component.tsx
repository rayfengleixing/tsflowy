import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function ToggleNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const collapsed = Boolean(node.attrs.collapsed);
  const title = collapsed ? t("toggle.expand") : t("toggle.collapse");

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/toggle relative my-2 rounded-lg border border-neutral-200 bg-white",
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className="flex items-start gap-1 px-1.5 py-1">
        <button
          type="button"
          title={title}
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200",
            !collapsed && "rotate-90",
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => updateAttributes({ collapsed: !collapsed })}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          {/* 第一块做"标题感"：用 CSS 加粗（不改 schema），保留所有嵌套块 */}
          <NodeViewContent
            className={cn(
              "transition-all duration-200",
              collapsed && "h-0 overflow-hidden opacity-0 pointer-events-none",
            )}
          />
          {collapsed && (
            <div className="py-1 text-[12px] italic text-neutral-400 select-none">
              {t("toggle.collapse") + "…"}
            </div>
          )}
        </div>
      </div>
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/toggle:flex"
        title="删除折叠块"
        onClick={() => deleteNode()}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
