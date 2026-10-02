import { useMemo } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Files } from "lucide-react";
import type { LayoutType } from "@/types/models";
import { findNode } from "@/lib/tree";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import type { SubpageItem } from "@/lib/subpages";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface SubpageRow {
  id: string;
  name: string;
  icon: string | null;
  layout: LayoutType;
}

// 子页面双链块渲染：优先读实时页面树（重命名/删除立即反映），
// 树里查不到时回退到节点自带的 items 快照（导出等离线场景）。
export function SubpagesNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, extension, selected } = props;
  const viewId = (extension.options as { viewId?: string | null }).viewId ?? null;
  const tree = useWorkspaceStore((s) => s.tree);
  const openView = useWorkspaceStore((s) => s.openView);
  const attrs = node.attrs as { items?: SubpageItem[] };

  const rows = useMemo<SubpageRow[]>(() => {
    const parent = viewId ? findNode(tree, viewId) : null;
    if (parent) {
      return parent.children.map((c) => ({ id: c.id, name: c.name, icon: c.icon, layout: c.layout }));
    }
    return (attrs.items ?? [])
      .filter((it) => typeof it.id === "string")
      .map((it) => ({ id: it.id, name: it.name, icon: null, layout: "document" }));
  }, [tree, viewId, attrs.items]);

  // 没有任何子页面时不占位（父文档里的空块会被 store 一并移除）
  if (rows.length === 0) return <NodeViewWrapper className="hidden" />;

  return (
    <NodeViewWrapper
      className={cn(
        "my-2 rounded-lg border border-neutral-200 bg-neutral-50/60 px-2.5 py-2",
        selected && "ring-2 ring-brand-500",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-neutral-500">
        <Files className="h-3.5 w-3.5" />
        <span>{t("subpages.title")}</span>
        <span className="text-neutral-400">{rows.length}</span>
      </div>
      <nav className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openView(r.id)}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[13px] text-neutral-700 hover:bg-brand-100"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[13px]">
              {viewIcon({ icon: r.icon, layout: r.layout })}
            </span>
            <span className="min-w-0 truncate">{r.name}</span>
          </button>
        ))}
      </nav>
    </NodeViewWrapper>
  );
}
