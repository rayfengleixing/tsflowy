import { useEffect } from "react";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabBar } from "@/features/tabs/TabBar";
import { TrashPage } from "@/features/trash/TrashPage";
import { PlaceholderPage } from "@/features/placeholder/PlaceholderPage";
import { Toaster } from "@/components/ui/sonner";
import { useWorkspaceStore } from "@/stores/workspace";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

function App() {
  const ready = useWorkspaceStore((s) => s.ready);
  const route = useWorkspaceStore((s) => s.route);

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

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {route === "trash" ? (
          <TrashPage />
        ) : (
          <>
            <TabBar />
            <PlaceholderPage />
          </>
        )}
      </div>
      <Toaster />
    </div>
  );
}

export default App;
