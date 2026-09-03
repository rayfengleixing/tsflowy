import { useEffect, useRef, useState } from "react";
import { Search, Settings, Star, Trash2 } from "lucide-react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { NewPageMenu } from "./NewPageMenu";
import { PageTree } from "./PageTree";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";

const MIN_WIDTH = 268;
const MAX_WIDTH = 560;

/** 侧边栏（说明书 6.3 结构）：空间区 32px / 搜索 30px / 新建 30px / 页面树 / 底部模板+回收站 */
export function Sidebar() {
  const { sidebarWidth, setSidebarWidth, route, setRoute, favorites, openView, openPalette } = useWorkspaceStore();
  const asideRef = useRef<HTMLElement>(null);
  const [resizing, setResizing] = useState(false);

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

      {/* 收藏置顶区 */}
      {favorites.length > 0 && (
        <div className="mt-1 border-t border-neutral-300/70 px-2 pt-1">
          <div className="flex h-[26px] items-center gap-1 px-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
            {t("sidebar.favorites")}
          </div>
          {favorites.map((v) => (
            <button
              key={v.id}
              data-fav-id={v.id}
              className="flex h-[30px] w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-neutral-800 hover:bg-neutral-300/40"
              onClick={() => openView(v.id)}
            >
              <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
              <span className="min-w-0 flex-1 truncate text-left">{v.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* 页面树 */}
      <PageTree />

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