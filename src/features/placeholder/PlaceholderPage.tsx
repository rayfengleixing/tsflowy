import { layoutMeta, viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { findNode } from "@/lib/tree";
import { t } from "@/lib/i18n";

/** 各布局占位页（M3 编辑器 / M4 Grid / M5 Board+Calendar 替换） */
export function PlaceholderPage() {
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const view = useWorkspaceStore((s) => (currentViewId ? findNode(s.tree, currentViewId) : null));

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("content.empty")}</div>
    );
  }

  const milestone = view.layout === "document" ? "M3" : view.layout === "grid" ? "M4" : "M5";
  const meta = layoutMeta(view.layout);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* 顶栏标题行（说明书 6.2：高 44px） */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <span className="text-lg leading-none">{viewIcon(view)}</span>
        <h1 className="min-w-0 truncate text-[15px] font-medium text-neutral-800">{view.name}</h1>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
        <span className="text-neutral-300">{meta.icon}</span>
        <p className="text-sm">{t("content.placeholder", { layout: meta.label, milestone })}</p>
      </div>
    </div>
  );
}
