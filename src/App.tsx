import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabBar } from "@/features/tabs/TabBar";
import { TrashPage } from "@/features/trash/TrashPage";
import { PlaceholderPage } from "@/features/placeholder/PlaceholderPage";
import { EditorPage } from "@/features/editor/EditorPage";
import { DatabasePage } from "@/features/database/DatabasePage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { DbUnavailable, type DbHealth } from "@/features/errors/DbUnavailable";
import { CommandPalette } from "@/features/search/CommandPalette";
import { SearchResultsPage } from "@/features/search/SearchResultsPage";
import { DatabaseViewPicker } from "@/features/editor/DatabaseViewPicker";
import { EmojiPickerDialog } from "@/features/editor/EmojiPickerDialog";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { bootstrapVisualSettings } from "@/stores/settings";
import { findNode } from "@/lib/tree";
import { mentionsApi } from "@/lib/mentions";
import { logger } from "@/lib/logger";
import { toast } from "sonner";
import { t, useLanguage } from "@/lib/i18n";
import { flushAllForClose, registerCloseFlush } from "@/lib/close-flush";
import { flushPendingUiPersist } from "@/stores/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { requestEscapeClose } from "@/lib/escape-close";

/** Ctrl+Tab / Ctrl+Shift+Tab 循环标签页；当前视图不在 tabs 里（如停在设置页）时落到第一个 */
function cycleTab(step: number) {
  const { tabs, currentViewId, openView } = useWorkspaceStore.getState();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((v) => v.id === currentViewId);
  openView(tabs[(idx + step + tabs.length) % tabs.length].id);
}

function App() {
  // Phase 4 修复 React 19 dev infinite-loop：
  // 从「返回 {a,b,c,d} 字面量 + shallow」改为「4 条原子 selector」，
  // 避免 useSyncExternalStore 的 getSnapshot 缓存检查把每次 new 对象判为不稳定。
  const ready = useWorkspaceStore((s) => s.ready);
  const route = useWorkspaceStore((s) => s.route);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const tree = useWorkspaceStore((s) => s.tree);

  // 订阅语言：t() 读 getState 不订阅，切换语言后靠这里触发整树重渲染刷新文案
  useLanguage();
  // 数据库健康状态：初始化后探一次，库打不开时用兜底页替代空工作区
  const [dbHealth, setDbHealth] = useState<DbHealth | null>(null);
  const [dbChecked, setDbChecked] = useState(false);
  // 关窗时保存失败 → 弹确认框；closeDecisionRef 持有用户的决定（true=仍要关闭）
  const [closeBlocked, setCloseBlocked] = useState(false);
  const closeDecisionRef = useRef<((proceed: boolean) => void) | null>(null);
  const resolveClose = (proceed: boolean) => closeDecisionRef.current?.(proceed);

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
      })
      .finally(() => {
        // 无论 init 成功与否都探一次库健康：连接失败时展示可操作的兜底页
        // （真实原因 + 库文件/数据目录/最近备份 + 打开目录/导入备份/重试），
        // 而不是让用户对着一个空工作区猜发生了什么。
        invoke<DbHealth>("db_health")
          .then(setDbHealth)
          .catch((e) => logger.error("App.dbHealth", "db_health failed", e))
          .finally(() => setDbChecked(true));
      });
  }, []);

  // Phase 2.1：应用启动 + 数据库就绪后，若 mentions 表为空（旧库升级），异步回填一次。
  // 不阻塞 UI；失败仅 warn（反链扫描会回退到旧 N 次 DB 查询路径，不致命）。
  useEffect(() => {
    if (!ready) return;
    mentionsApi.backfillIfEmpty().catch(logger.catch("App.backfillMentions", "mentions backfill failed"));
  }, [ready]);

  // 全局快捷键（与 Settings 快捷键表一致）：
  // Ctrl+K / Ctrl+P 命令面板 · Ctrl+Shift+F 全局搜索 · Ctrl+Tab 切换标签页 · Esc 关闭浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const metaOrCtrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (metaOrCtrl && !e.shiftKey && (key === "k" || key === "p")) {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        if (s.paletteOpen) s.closePalette();
        else s.openPalette();
        return;
      }
      if (metaOrCtrl && e.shiftKey && key === "f") {
        e.preventDefault();
        useWorkspaceStore.getState().openSearch("");
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab：循环打开的标签页（macOS 的 ⌘+Tab 是系统切换，故只认 Ctrl）
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Escape") {
        const s = useWorkspaceStore.getState();
        // 命令面板自己也会处理 Esc，这里先一步收掉，避免同一次按键再触发下面的广播
        if (s.paletteOpen) {
          s.closePalette();
          return;
        }
        requestEscapeClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 关窗前统一落盘：preventDefault 拦住关窗 → await 所有注册的冲刷（5s 看门狗兜底，
  // 落库卡死也保证窗口最终能关）→ destroy。destroy 不再触发 close-requested，无二次拦截。
  // 有内容落库失败时弹确认框：用户可取消关闭、留在应用内重试，而不是静默丢数据。
  useEffect(() => {
    const unregisterUi = registerCloseFlush(flushPendingUiPersist);
    let disposed = false;
    const listening = getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (closeDecisionRef.current) return; // 确认框已弹出，忽略重复的关闭请求
      const flushed = await Promise.race([
        flushAllForClose(),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (disposed) return;
      if (!flushed) {
        const proceed = await new Promise<boolean>((resolve) => {
          closeDecisionRef.current = resolve;
          setCloseBlocked(true);
        });
        closeDecisionRef.current = null;
        setCloseBlocked(false);
        if (!proceed) return; // 用户选择留在应用内
      }
      try {
        await getCurrentWindow().destroy();
      } catch (e) {
        logger.error("App", "window destroy failed", e);
      }
    });
    return () => {
      disposed = true;
      unregisterUi();
      void listening.then((unlisten) => unlisten());
    };
  }, []);

  // 等健康探测落地再渲染，避免库故障时先闪一下空工作区
  if (!ready || !dbChecked) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  if (dbHealth && !dbHealth.ok) {
    return <DbUnavailable health={dbHealth} />;
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
              <DatabasePage key={view.id} view={view} />
            ) : (
              <PlaceholderPage />
            )}
          </>
        )}
      </div>
      <CommandPalette />
      <DatabaseViewPicker />
      <EmojiPickerDialog />
      <ConfirmDialog
        open={closeBlocked}
        onOpenChange={(open) => {
          if (!open) resolveClose(false);
        }}
        title={t("close.failedTitle")}
        description={t("close.failedDesc")}
        confirmLabel={t("close.failedConfirm")}
        onConfirm={() => resolveClose(true)}
      />
      <Toaster />
    </div>
  );
}

export default App;
