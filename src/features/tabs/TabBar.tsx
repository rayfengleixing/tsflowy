import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

/** 顶部标签栏（说明书 6.4：高 40px、标签宽 200px、可切换/关闭/拖拽排序） */
export function TabBar() {
  const { tabs, currentViewId, openView, closeTab, newTab, reorderTabs } = useWorkspaceStore();
  const dragIndex = useRef<number | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndex.current = index;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    if (dragIndex.current === null) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const to = before ? index : index + 1;
    const from = dragIndex.current;
    if (from !== index && to !== from && to !== from + 1) {
      reorderTabs(from, to);
      dragIndex.current = to > from ? to - 1 : to;
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
      {tabs.map((v: View, index: number) => {
        const active = v.id === currentViewId;
        return (
          <div
            key={v.id}
            data-tab-id={v.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onClick={() => openView(v.id)}
            className={
              "group relative flex w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-neutral-300 px-2 text-[13px] " +
              (active
                ? "bg-white text-neutral-800"
                : "text-neutral-500 hover:bg-neutral-200/60")
            }
          >
            {active && <div className="absolute inset-x-0 top-0 h-[2px] bg-brand-500" />}
            <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            <button
              data-testid="tab-close"
              className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300 group-hover:flex"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(v.id);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        data-testid="new-tab"
        className="flex w-8 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-200/60"
        title={t("tabs.newTab")}
        onClick={() => newTab()}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
