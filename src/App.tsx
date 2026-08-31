import { useEffect } from "react";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabBar } from "@/features/tabs/TabBar";
import { TrashPage } from "@/features/trash/TrashPage";
import { PlaceholderPage } from "@/features/placeholder/PlaceholderPage";
import { EditorPage } from "@/features/editor/EditorPage";
import { CommandPalette } from "@/features/search/CommandPalette";
import { SearchResultsPage } from "@/features/search/SearchResultsPage";
import { Toaster } from "@/components/ui/sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { findNode } from "@/lib/tree";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

function App() {
  const ready = useWorkspaceStore((s) => s.ready);
  const route = useWorkspaceStore((s) => s.route);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const tree = useWorkspaceStore((s) => s.tree);

  useEffect(() => {
    useWorkspaceStore
      .getState()
      .init()
      .catch((e) => {
        console.error("app init failed", e);
        toast.error(t("error.db", { message: String(e) }));
        useWorkspaceStore.setState({ ready: true }); // 退出加载态，避免无限转圈
      });
  }, []);

  // 全局快捷键：Ctrl+K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        if (s.paletteOpen) s.closePalette();
        else s.openPalette();
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
        ) : (
          <>
            <TabBar />
            {view && view.layout === "document" ? (
              <EditorPage key={view.id} view={view} />
            ) : (
              <PlaceholderPage />
            )}
          </>
        )}
      </div>
      <CommandPalette />
      <Toaster />
    </div>
  );
}

export default App;
