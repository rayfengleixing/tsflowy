import { useEffect, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ChevronRight, Link as LinkIcon, X } from "lucide-react";
import type { View } from "@/types/models";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function SubPageNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, deleteNode, selected } = props;
  const viewId = node.attrs.viewId as string | null;
  const tree = useWorkspaceStore((s) => s.tree);
  const openView = useWorkspaceStore((s) => s.openView);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    if (!viewId) { setView(null); return; }
    const flat = flattenTree(tree) as View[];
    const found = flat.find((n) => n.id === viewId) ?? null;
    setView(found);
  }, [viewId, tree]);

  const goto = () => {
    if (viewId) openView(viewId);
  };

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/subpage relative my-3 cursor-pointer rounded-lg border border-neutral-200 bg-white transition hover:bg-brand-50",
        selected && "ring-2 ring-brand-500",
      )}
      onClick={goto}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-lg leading-none">{view ? viewIcon(view) : <LinkIcon className="h-5 w-5" />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-neutral-800">
            {view?.name || (viewId ? `${t("subPage.placeholder")} (${viewId.slice(0, 6)})` : t("subPage.placeholder"))}
          </div>
          <div className="text-[11px] text-neutral-400">
            {view ? `${view.layout.toUpperCase()} · ${view.id.slice(0, 6)}` : "—"}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-neutral-400 group-hover/subpage:text-brand-500" />
      </div>
      <button
        className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/subpage:flex"
        title="删除子页面"
        onClick={(e) => { e.stopPropagation(); deleteNode(); }}
      >
        <X className="h-4 w-4" />
      </button>
    </NodeViewWrapper>
  );
}
