import { useEffect, useRef, useState } from "react";
import { Search, Settings, Trash2, Layers, Clock } from "lucide-react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { NewPageMenu } from "./NewPageMenu";
import { PageTree } from "./PageTree";
import { RecentTab } from "./RecentTab";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";

const MIN_WIDTH = 268;
const MAX_WIDTH = 560;

/** 侧边栏（说明书 6.3 结构）+ 新增 B-3：Tree/Recent Tab 切换，Recent 含「最近/收藏」二级 Tab。 */
export function Sidebar() {
  const { sidebarWidth, setSidebarWidth, route, setRoute, openPalette } = useWorkspaceStore();
  const asideRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);
  const [mainTab, setMainTab] = useState<"tree" | "recent">("tree");

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
          <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1 text-[10px] text-neutral-400">Ctrl K</kbd>
        </button>
      </div>

      {/* 新建页面 */}
      <div className="px-2">
        <NewPageMenu />
      </div>

      {/* B-3：侧边栏一级 Tab（PageTree / RecentTab）切换。不再把 favorites 单独置顶（移到 RecentTab.favorites tab 里统一展示）。 */}
      <div className="flex items-stretch border-b border-neutral-300 text-[11px]">
        <button
          type="button"
          onClick={() => setMainTab("tree")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (mainTab === "tree" ? "bg-white text-brand-600 border-b-2 border-brand-500" : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Layers className="h-3 w-3" />
          {t("sidebar.pageTree")}
        </button>
        <button
          type="button"
          onClick={() => setMainTab("recent")}
          className={
            "flex flex-1 items-center justify-center gap-1 py-1.5 " +
            (mainTab === "recent" ? "bg-white text-brand-600 border-b-2 border-brand-500" : "text-neutral-500 hover:bg-neutral-200/60")
          }
        >
          <Clock className="h-3 w-3" />
          {t("sidebar.recentAndFav")}
        </button>
      </div>

      {/* 内容区：根据 mainTab 切换 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mainTab === "tree" ? <PageTree /> : <RecentTab />}
      </div>

      {/* 旧的「收藏置顶区」已移除（统一在 RecentTab.favorites tab 内维护） */}

      {/* 底部固定区：回收站 / 设置（模板功能尚未实现，已按要求移除入口） */}
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

      {/* 拖拽调宽手柄 */}
      <div
        data-testid="sidebar-resizer"
        className="absolute -right-[2px] top-0 h-full w-[5px] cursor-col-resize hover:bg-brand-500/40"
        onMouseDown={() => setResizing(true)}
      />
    </aside>
  );
}