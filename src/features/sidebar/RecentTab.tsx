import { useEffect, useState } from "react";
import { Clock, Star } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi } from "@/lib/db";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

/**
 * Sidebar 右栏：最近访问 / 收藏夹（B-3 接入）。
 *
 * 两 Tab 切换（Recent / Favorites）。
 *  - 最近：调用 viewApi.listRecent，返回 View[]
 *  - 收藏：store.favorites 是 View[]
 * 两侧用 View 统一（viewIcon 只依赖 layout/icon/name 字段），不需要 children 的 ViewNode 维度。
 */
export function RecentTab() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const favorites = useWorkspaceStore((s) => s.favorites);
  const openView = useWorkspaceStore((s) => s.openView);
  const toggleFavorite = useWorkspaceStore((s) => s.toggleFavorite);

  const [tab, setTab] = useState<"recent" | "favorite">("recent");
  const [recent, setRecent] = useState<View[]>([]);

  useEffect(() => {
    if (!currentWorkspaceId) return;
    void viewApi.listRecent(currentWorkspaceId).then(setRecent);
  }, [currentWorkspaceId, tab]);

  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  useEffect(() => {
    if (!currentWorkspaceId || !currentViewId) return;
    void viewApi.listRecent(currentWorkspaceId).then(setRecent);
  }, [currentWorkspaceId, currentViewId]);

  const rows: View[] = tab === "recent" ? recent : favorites;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-stretch border-b border-neutral-200 text-[11px]">
        <button
          type="button"
          onClick={() => setTab("recent")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (tab === "recent" ? "bg-white text-brand-600 border-b-2 border-brand-500" : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Clock className="h-3 w-3" />
          {t("sidebar.tab.recent")}
        </button>
        <button
          type="button"
          onClick={() => setTab("favorite")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (tab === "favorite" ? "bg-white text-brand-600 border-b-2 border-brand-500" : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Star className="h-3 w-3" />
          {t("sidebar.favorites")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-neutral-400">
            {tab === "recent" ? t("sidebar.recentEmpty") : t("sidebar.favoriteEmpty")}
          </div>
        ) : (
          rows.map((v) => (
            <div
              key={v.id}
              className="group flex items-center gap-1.5 px-2 py-1 hover:bg-neutral-200/60"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => openView(v.id)}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-700">
                  {v.name || t("common.untitled")}
                </span>
              </button>
              <button
                type="button"
                onClick={() => toggleFavorite(v.id)}
                className={
                  "hidden h-5 w-5 shrink-0 items-center justify-center rounded group-hover:flex " +
                  ((v as unknown as { is_favorite?: number }).is_favorite === 1
                    ? "text-yellow-500"
                    : "text-neutral-400 hover:text-yellow-500")
                }
                title={t("sidebar.toggleFavorite")}
              >
                <Star
                  className="h-3 w-3"
                  fill={(v as unknown as { is_favorite?: number }).is_favorite === 1 ? "currentColor" : "none"}
                />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
