import { useEffect, useState } from "react";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabBar } from "@/features/tabs/TabBar";
import { TrashPage } from "@/features/trash/TrashPage";
import { PlaceholderPage } from "@/features/placeholder/PlaceholderPage";
import { EditorPage } from "@/features/editor/EditorPage";
import { GridView } from "@/features/database/GridView";
import { BoardView } from "@/features/database/BoardView";
import { CalendarView } from "@/features/database/CalendarView";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { CommandPalette } from "@/features/search/CommandPalette";
import { SearchResultsPage } from "@/features/search/SearchResultsPage";
import { DatabaseViewPicker } from "@/features/editor/DatabaseViewPicker";
import { EmojiPickerDialog } from "@/features/editor/EmojiPickerDialog";
import { Toaster } from "@/components/ui/sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { bootstrapVisualSettings } from "@/stores/settings";
import { findNode } from "@/lib/tree";
import { mentionsApi } from "@/lib/mentions";
import { logger } from "@/lib/logger";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

type ViewMode = "grid" | "board" | "calendar";

/** 数据库视图包装器：管理视图模式切换（Grid/Board/Calendar 共用同一份数据） */
function DatabaseViewWrapper({ view }: { view: View }) {
  const [viewMode, setViewMode] = useState<ViewMode>(
    view.layout === "board" ? "board" : view.layout === "calendar" ? "calendar" : "grid",
  );

  if (viewMode === "board") {
    return <BoardView key={view.id + "-board"} view={view} viewMode="board" onViewModeChange={setViewMode} />;
  }
  if (viewMode === "calendar") {
    return <CalendarView key={view.id + "-calendar"} view={view} viewMode="calendar" onViewModeChange={setViewMode} />;
  }
  return <GridView key={view.id + "-grid"} view={view} viewMode="grid" onViewModeChange={setViewMode} />;
}

function App() {
  // Phase 4 修复 React 19 dev infinite-loop：
  // 从「返回 {a,b,c,d} 字面量 + shallow」改为「4 条原子 selector」，
  // 避免 useSyncExternalStore 的 getSnapshot 缓存检查把每次 new 对象判为不稳定。
  const ready = useWorkspaceStore((s) => s.ready);
  const route = useWorkspaceStore((s) => s.route);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const tree = useWorkspaceStore((s) => s.tree);

  // 应用设置（主题/强调色/字体）：启动立即写一次，返回 unsubscribe（system 模式下监听 matchMedia）
  useEffect(() => {
    const cleanupTheme = bootstrapVisualSettings();
    return cleanupTheme;
  }, []);

  useEffect(() => {
    useWorkspaceStore
      .getState()
      .init()
      .catch((e) => {
        // ready=true 已在 WorkspaceStore.init() 内部 catch 分支最终保证；
        // 这里不再外部 setState，避免触发额外 zustand emit → React 19 useSyncExternalStore 缓存告警。
        logger.error("App.init", "app init failed", e);
        toast.error(t("error.db", { message: String(e) }));
      });
  }, []);

  // Phase 2.1：应用启动 + 数据库就绪后，若 mentions 表为空（旧库升级），异步回填一次。
  // 不阻塞 UI；失败仅 warn（反链扫描会回退到旧 N 次 DB 查询路径，不致命）。
  useEffect(() => {
    if (!ready) return;
    mentionsApi.backfillIfEmpty().catch(logger.catch("App.backfillMentions", "mentions backfill failed"));
  }, [ready]);

  // 全局快捷键：Ctrl+K 命令面板 · Ctrl+Shift+F 全局搜索（与 Settings 快捷键表一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const metaOrCtrl = e.ctrlKey || e.metaKey;
      if (metaOrCtrl && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        if (s.paletteOpen) s.closePalette();
        else s.openPalette();
      }
      if (metaOrCtrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        s.openSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  const view = currentViewId ? findNode(tree, currentViewId) : null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {route === "trash" ? (
          <TrashPage />
        ) : route === "search" ? (
          <SearchResultsPage />
        ) : route === "settings" ? (
          <SettingsPage />
        ) : (
          <>
            <TabBar />
            {view && view.layout === "document" ? (
              <EditorPage key={view.id} view={view} />
            ) : view && (view.layout === "grid" || view.layout === "board" || view.layout === "calendar") ? (
              <DatabaseViewWrapper key={view.id} view={view} />
            ) : (
              <PlaceholderPage />
            )}
          </>
        )}
      </div>
      <CommandPalette />
      <DatabaseViewPicker />
      <EmojiPickerDialog />
      <Toaster />
    </div>
  );
}

export default App;
