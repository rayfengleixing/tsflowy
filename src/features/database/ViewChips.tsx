import { useState } from "react";
import { Calendar, LayoutGrid, Plus, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { viewApi } from "@/lib/db";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { DB_LAYOUTS, type DbLayout, type LayoutType, type View } from "@/types/models";

// 数据库多视图标签栏（阶段 2）：一张表的每个视图都是一行 views（派生视图带 source_id），
// 所以这里管理的是"配置行"的增删改，不是页面——数据始终挂在宿主视图上。
// 宿主既是页面本身也是它的默认视图，因此宿主 chip 不可删除，双击等于重命名页面。

const LAYOUT_ICON: Partial<Record<LayoutType, React.ReactNode>> = {
  grid: <Table2 className="h-3.5 w-3.5" />,
  board: <LayoutGrid className="h-3.5 w-3.5" />,
  calendar: <Calendar className="h-3.5 w-3.5" />,
};

const iconOf = (view: View): React.ReactNode => LAYOUT_ICON[view.layout] ?? LAYOUT_ICON.grid;

const layoutLabel = (layout: DbLayout): string => t(`dbViewMode.${layout}`);

export function ViewChips({
  source,
  views,
  activeId,
  onSelect,
  onCreated,
  onRenamed,
  onDeleted,
}: {
  source: View;
  views: View[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreated: (view: View) => void;
  onRenamed: (id: string, name: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const commitRename = async (view: View) => {
    setRenaming(null);
    const name = draft.trim();
    if (!name || name === view.name) return;
    try {
      if (view.id === source.id) {
        // 宿主 = 页面本身，重命名要同步页面树
        await useWorkspaceStore.getState().renameView(view.id, name);
      } else {
        await viewApi.rename(view.id, name);
      }
      onRenamed(view.id, name);
    } catch (e) {
      logger.error("view-chips.rename", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const remove = async (view: View) => {
    try {
      await viewApi.purge(view.id); // 派生视图只是显示配置，硬删不进回收站
      onDeleted(view.id);
    } catch (e) {
      logger.error("view-chips.delete", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const create = async (layout: DbLayout) => {
    setMenuOpen(false);
    try {
      const view = await viewApi.create({
        workspace_id: source.workspace_id,
        parent_id: null,
        name: layoutLabel(layout),
        layout,
        source_id: source.id,
      });
      onCreated(view);
    } catch (e) {
      logger.error("view-chips.create", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-md border border-neutral-300 bg-white text-xs">
      {views.map((view) => {
        const active = view.id === activeId;
        const derived = view.id !== source.id;
        return (
          <div
            key={view.id}
            className={cn(
              "group/chip flex shrink-0 items-center gap-1 rounded px-2 py-1 transition",
              active ? "bg-brand-100 font-medium text-brand-700" : "text-neutral-600 hover:bg-neutral-100",
            )}
          >
            {iconOf(view)}
            {renaming === view.id ? (
              <input
                autoFocus
                className="w-24 rounded border border-brand-500 px-1 text-xs outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(view)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                className="max-w-40 truncate"
                title={view.name}
                onClick={() => onSelect(view.id)}
                onDoubleClick={() => {
                  setDraft(view.name);
                  setRenaming(view.id);
                }}
              >
                {view.name}
              </button>
            )}
            {derived && (
              // 常占位、只切透明度：切 display 会让右对齐的标签栏在指针下重新排布，
              // 双击改名时可能正好把 ✕ 挪到落点，误删视图
              <button
                className="flex h-4 w-4 shrink-0 cursor-default items-center justify-center rounded text-neutral-400 opacity-0 transition pointer-events-none group-hover/chip:pointer-events-auto group-hover/chip:opacity-100 hover:bg-red-100 hover:text-red-500"
                title={t("dbView.delete")}
                onClick={() => void remove(view)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      <div className="relative">
        <button
          className="flex h-6 w-6 items-center justify-center text-neutral-500 hover:bg-neutral-100"
          title={t("dbView.new")}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-7 z-20 w-32 rounded-md border border-neutral-200 bg-white py-1 shadow-md">
              {DB_LAYOUTS.map((layout) => (
                <button
                  key={layout}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
                  onClick={() => void create(layout)}
                >
                  {LAYOUT_ICON[layout]}
                  {layoutLabel(layout)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
