import { useEffect, useRef, useState } from "react";
import { Search, Settings, Trash2, Star, Layers, Hash } from "lucide-react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { NewPageMenu } from "./NewPageMenu";
import { PageTree } from "./PageTree";
import { DocumentOutline, getSidebarTab, setSidebarTab } from "@/features/editor/Outline";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";

const MIN_WIDTH = 268;
const MAX_WIDTH = 560;

/** 侧边栏（说明书 6.3 结构）：页面树 / 大纲 / 收藏 三 Tab 切换 */
export function Sidebar() {
  const sidebarWidth = useWorkspaceStore((s) => s.sidebarWidth);
  const setSidebarWidth = useWorkspaceStore((s) => s.setSidebarWidth);
  const route = useWorkspaceStore((s) => s.route);
  const setRoute = useWorkspaceStore((s) => s.setRoute);
  const favorites = useWorkspaceStore((s) => s.favorites);
  const openView = useWorkspaceStore((s) => s.openView);
  const openPalette = useWorkspaceStore((s) => s.openPalette);
  const toggleFavorite = useWorkspaceStore((s) => s.toggleFavorite);
  const asideRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const [mainTab, setMainTab] = useState<"tree" | "outline" | "favorites">(getSidebarTab());

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      setSidebarWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - left)));
    };
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, setSidebarWidth]);

  const switchTab = (tab: "tree" | "outline" | "favorites") => {
    setMainTab(tab);
    setSidebarTab(tab);
  };

  return (
    <aside
      ref={asideRef}
      className="relative flex shrink-0 flex-col border-r border-neutral-300 bg-sidebar text-sidebar-foreground"
      style={{ width: sidebarWidth }}
    >
      {/* 空间切换 */}
      <SpaceSwitcher />

      {/* 搜索框 */}
      <div className="px-2">
        <button
          data-testid="sidebar-search"
          className="flex h-[30px] w-full items-center gap-1.5 rounded-md px-2 text-[13px] text-neutral-500 hover:bg-neutral-300/60"
          onClick={openPalette}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">{t("sidebar.search")}</span>
          <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1 text-[10px] text-neutral-400">
            Ctrl K
          </kbd>
        </button>
      </div>

      {/* 一级 Tab：页面树 / 大纲 / 收藏 */}
      <div className="flex items-stretch border-b border-neutral-300 text-[11px]">
        <button
          type="button"
          onClick={() => switchTab("tree")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (mainTab === "tree"
              ? "bg-white text-brand-600 border-b-2 border-brand-500"
              : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Layers className="h-3 w-3" />
          {t("sidebar.pageTree")}
        </button>
        <button
          type="button"
          onClick={() => switchTab("outline")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (mainTab === "outline"
              ? "bg-white text-brand-600 border-b-2 border-brand-500"
              : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Hash className="h-3 w-3" />
          {t("sidebar.tab.outline")}
        </button>
        <button
          type="button"
          onClick={() => switchTab("favorites")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (mainTab === "favorites"
              ? "bg-white text-brand-600 border-b-2 border-brand-500"
              : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Star className="h-3 w-3" />
          {t("sidebar.favorites")}
        </button>
      </div>

      {/* 内容区：根据 mainTab 切换 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mainTab === "tree" ? (
          <PageTree />
        ) : mainTab === "outline" ? (
          <DocumentOutline />
        ) : (
          <div className="h-full overflow-y-auto px-2 py-1">
            {favorites.length === 0 ? (
              <p className="px-2 py-4 text-[12px] text-neutral-400">{t("sidebar.favoritesEmpty")}</p>
            ) : (
              favorites.map((v) => (
                <div
                  key={v.id}
                  className="group flex h-[30px] items-center gap-1.5 rounded-md px-1.5 hover:bg-neutral-300/40"
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-neutral-800"
                    onClick={() => openView(v.id)}
                  >
                    <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                      {viewIcon(v)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{v.name}</span>
                  </button>
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={() => toggleFavorite(v.id)}
                    title={t("sidebar.unfavorite")}
                  >
                    <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 底部固定区：新建页面 / 回收站 / 设置 */}
      <div className="flex h-[100px] shrink-0 flex-col border-t border-neutral-300">
        <div className="flex-1 px-2 py-1.5">
          <NewPageMenu />
        </div>
        <div className="flex h-[60px] shrink-0 items-stretch border-t border-neutral-300">
          <button
            data-testid="trash-button"
            className={
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] hover:bg-neutral-300/50 " +
              (route === "trash" ? "text-brand-600 bg-neutral-300/50" : "text-neutral-600")
            }
            onClick={() => setRoute(route === "trash" ? "workspace" : "trash")}
          >
            <Trash2 className="h-4 w-4" />
            {t("sidebar.trash")}
          </button>
          <div className="w-px self-stretch bg-neutral-300" />
          <button
            className={
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] hover:bg-neutral-300/50 " +
              (route === "settings" ? "text-brand-600 bg-neutral-300/50" : "text-neutral-600")
            }
            onClick={() => setRoute(route === "settings" ? "workspace" : "settings")}
            title={t("settings.title")}
          >
            <Settings className="h-4 w-4" />
            {t("settings.title")}
          </button>
        </div>
      </div>

      {/* 拖拽调宽手柄 */}
      <div
        data-testid="sidebar-resizer"
        className="absolute -right-[2px] top-0 h-full w-[5px] cursor-col-resize hover:bg-brand-500/40"
        onMouseDown={() => setResizing(true)}
      />
    </aside>
  );
}
