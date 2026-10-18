import { Suspense, useEffect, useRef, useState } from "react";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { TabBar, panelDomId, tabDomId } from "@/features/tabs/TabBar";
import { PlaceholderPage } from "@/features/placeholder/PlaceholderPage";
import { AiPanel } from "@/features/ai/AiPanel";
import { DbUnavailable, type DbHealth } from "@/features/errors/DbUnavailable";
import { CommandPalette } from "@/features/search/CommandPalette";
import { crashRestartRound } from "@/lib/app-shell";
import { DatabaseViewPicker } from "@/features/editor/DatabaseViewPicker";
import { EmojiPickerDialog } from "@/features/editor/EmojiPickerDialog";
import { RouteErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { viewIcon } from "@/components/view-icon";
import { ArrowLeftRight, X } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useAiStore } from "@/stores/ai";
import { bootstrapVisualSettings, useSettingsStore } from "@/stores/settings";
import { loadDailyNotesConfig } from "@/lib/daily-notes";
import { findNode } from "@/lib/tree";
import { isDbLayout, type ViewNode } from "@/types/models";
import { mentionsApi } from "@/lib/mentions";
import { logger } from "@/lib/logger";
import { toast } from "sonner";
import { t, useLanguage } from "@/lib/i18n";
import { flushAllForClose, registerCloseFlush } from "@/lib/close-flush";
import { startAutoSync } from "@/lib/auto-sync";
import { startUpdateChecks } from "@/lib/update-check";
import { probeDbHealthOnStartup } from "@/lib/db-health";
import { startSyncEvents } from "@/lib/sync-events";
import { flushPendingUiPersist } from "@/stores/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import { requestEscapeClose } from "@/lib/escape-close";
import { setupDeepLink } from "@/lib/deep-link";
import { useShortcutsStore, comboEquals, eventToCombo } from "@/lib/shortcuts";
import { lazyWithRetry } from "@/lib/lazy";

// 路由级懒加载：编辑页（含 TipTap 及全部扩展）/ 数据库页 / 设置页 / 回收站 / 搜索结果页
// 体积较大且互斥，拆成独立 chunk 按需加载，缩短启动时主包的解析时间（fallback 复用 app.loading）。
// lazyWithRetry：chunk 请求偶发失败自动重试，避免加载异常直接把整棵树打崩（白屏）。
const EditorPage = lazyWithRetry(() => import("@/features/editor/EditorPage").then((m) => ({ default: m.EditorPage })));
const DatabasePage = lazyWithRetry(() =>
  import("@/features/database/DatabasePage").then((m) => ({ default: m.DatabasePage })),
);
const SettingsPage = lazyWithRetry(() =>
  import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const TrashPage = lazyWithRetry(() => import("@/features/trash/TrashPage").then((m) => ({ default: m.TrashPage })));
const SearchResultsPage = lazyWithRetry(() =>
  import("@/features/search/SearchResultsPage").then((m) => ({ default: m.SearchResultsPage })),
);

/** Ctrl+Tab / Ctrl+Shift+Tab 循环标签页；当前视图不在 tabs 里（如停在设置页）时落到第一个 */
function cycleTab(step: number) {
  const { tabs, currentViewId, openView } = useWorkspaceStore.getState();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((v) => v.id === currentViewId);
  openView(tabs[(idx + step + tabs.length) % tabs.length].id);
}

/** 按视图布局渲染主内容（单栏与左右分栏共用） */
function renderView(view: ViewNode | null) {
  if (view?.layout === "document") return <EditorPage key={view.id} view={view} />;
  if (view && isDbLayout(view.layout)) {
    return <DatabasePage key={view.id} view={view} />;
  }
  return <PlaceholderPage />;
}

/**
 * 主内容区与标签的配对语义。有对应标签时是 tabpanel（读屏器能把「标签 → 内容」连起来念），
 * 专注模式藏掉了标签栏、或当前没有页面时退回 main 地标 —— 不能让 aria-labelledby 指向此刻不存在的元素。
 */
function tabPanel(viewId: string | null, hasTabs: boolean) {
  return viewId && hasTabs
    ? { role: "tabpanel" as const, id: panelDomId(viewId), "aria-labelledby": tabDomId(viewId) }
    : { role: "main" as const };
}

/** 分栏单侧顶部条：显示页面图标与名称；副栏额外提供互换/取消并排 */
function PaneHeader({ view, onSwap, onClose }: { view: ViewNode | null; onSwap?: () => void; onClose?: () => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-2 text-[12px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <span className="flex w-4 shrink-0 items-center justify-center text-neutral-500">
        {view ? viewIcon(view) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{view ? view.name : t("content.empty")}</span>
      {onSwap && (
        <button
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title={t("split.swap")}
          onClick={onSwap}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
      )}
      {onClose && (
        <button
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title={t("split.close")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** 并排对照：左栏 = 当前视图，右栏 = 副视图，中间可拖拽调整比例 */
function SplitView({ left, right, hasTabs }: { left: ViewNode | null; right: ViewNode; hasTabs: boolean }) {
  const splitRatio = useWorkspaceStore((s) => s.splitRatio);
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio);
  const swapSplit = useWorkspaceStore((s) => s.swapSplit);
  const closeSplit = useWorkspaceStore((s) => s.closeSplit);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      setSplitRatio((ev.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-col" style={{ width: `${splitRatio * 100}%` }}>
        <PaneHeader view={left} />
        <div className="min-h-0 flex-1 overflow-hidden" {...tabPanel(left?.id ?? null, hasTabs)}>
          {renderView(left)}
        </div>
      </div>
      <div
        data-testid="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("split.dragHint")}
        className="w-1 shrink-0 cursor-col-resize bg-neutral-200 transition-colors hover:bg-brand-400 dark:bg-neutral-700"
        title={t("split.dragHint")}
        onMouseDown={startDrag}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PaneHeader view={right} onSwap={swapSplit} onClose={closeSplit} />
        <div className="min-h-0 flex-1 overflow-hidden" role="region" aria-label={t("split.sidePane")}>
          {renderView(right)}
        </div>
      </div>
    </div>
  );
}

function App() {
  // Phase 4 修复 React 19 dev infinite-loop：
  // 从「返回 {a,b,c,d} 字面量 + shallow」改为「4 条原子 selector」，
  // 避免 useSyncExternalStore 的 getSnapshot 缓存检查把每次 new 对象判为不稳定。
  const ready = useWorkspaceStore((s) => s.ready);
  const route = useWorkspaceStore((s) => s.route);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const splitViewId = useWorkspaceStore((s) => s.splitViewId);
  const tree = useWorkspaceStore((s) => s.tree);
  // 专注模式：藏起界面外壳，只留正文。只在工作区生效——设置/搜索/回收站是整页视图，
  // 没了侧边栏就走不回来。
  const focusMode = useSettingsStore((s) => s.focusMode);
  const focusChrome = focusMode && route === "workspace";

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
      .catch((e: unknown) => {
        // ready=true 已在 WorkspaceStore.init() 内部 catch 分支最终保证；
        // 这里不再外部 setState，避免触发额外 zustand emit → React 19 useSyncExternalStore 缓存告警。
        logger.error("App.init", "app init failed", e);
        toast.error(t("error.db", { message: String(e) }));
      })
      .then(() => {
        // 启动自动打开今日笔记（设置项，默认关闭）；失败只记日志，不打扰启动流程
        if (loadDailyNotesConfig().openOnStart) {
          useWorkspaceStore.getState().openDailyNote().catch(logger.catch("App.dailyNote", "open daily note failed"));
        }
      })
      .finally(() => {
        // 无论 init 成功与否都探一次库健康：连接失败时展示可操作的兜底页
        // （真实原因 + 库文件/数据目录/最近备份 + 打开目录/导入备份/重试），
        // 而不是让用户对着一个空工作区猜发生了什么。
        invoke<DbHealth>("db_health")
          .then(setDbHealth)
          .catch((e: unknown) => logger.error("App.dbHealth", "db_health failed", e))
          .finally(() => setDbChecked(true));
      })
      // 链路末端兜底：then/finally 回调里的同步异常不该悬空抛掉
      .catch((e: unknown) => logger.error("App.init", "startup chain failed", e));
  }, []);

  // Phase 2.1：应用启动 + 数据库就绪后，若 mentions 表为空（旧库升级），异步回填一次。
  // 不阻塞 UI；失败仅 warn（反链扫描会回退到旧 N 次 DB 查询路径，不致命）。
  useEffect(() => {
    if (!ready) return;
    mentionsApi.backfillIfEmpty().catch(logger.catch("App.backfillMentions", "mentions backfill failed"));
  }, [ready]);

  // 自动同步（B7）：数据就绪后启动。启动拉取立即执行一次；
  // 写入后自动同步由 main.tsx 包装的 invoke 咽喉点驱动防抖定时器（见 lib/auto-sync.ts）。
  // 先挂上同步事件监听再启动：本机库被替换的那一刻靠 sync:db-replaced 通知前端重载，
  // "启动时自动同步一次"是紧接着就跑的，监听晚一帧就会漏掉那次重载。
  useEffect(() => {
    if (!ready) return;
    void startSyncEvents().then(() => startAutoSync());
  }, [ready]);

  // 启动后的数据库结构巡检：库能打开不等于库是好的，坏了要趁还能操作时说一句。
  // 延迟一会儿再跑（避开首屏渲染与自动同步抢磁盘 I/O），一切正常时不出声。
  useEffect(() => {
    if (!ready) return;
    void probeDbHealthOnStartup();
  }, [ready]);

  // 自动检查更新（默认关，设置 → 软件更新 里开）：偏好为关时这里不排任何定时器、不联网
  useEffect(() => {
    if (!ready) return;
    startUpdateChecks();
  }, [ready]);

  // 本次进程是崩溃后自动拉起来的：告诉用户一句，并给个去日志/看开关的入口。
  // 不挂 ready 依赖——「上一轮崩了」是进程级事实，工作区加载快慢不该改变它何时出声。
  useEffect(() => {
    void crashRestartRound().then((round) => {
      if (round <= 0) return;
      toast.error(t("app.crashRestarted", { round }), {
        duration: 0,
        action: {
          label: t("settings.updateGoSettings"),
          onClick: () => useWorkspaceStore.getState().setRoute("settings"),
        },
      });
    });
  }, []);

  // 全局快捷键（可在 设置 → 快捷键 里自定义）：
  // 命令面板 / 快速打开 · 全局搜索 · 切换标签页；Esc 固定不可改（关闭浮层）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 固定：命令面板自己也会处理，这里先一步收掉，避免同一次按键再触发下面的广播
      if (e.key === "Escape") {
        const s = useWorkspaceStore.getState();
        if (s.paletteOpen) {
          s.closePalette();
          return;
        }
        // 专注模式没有常驻按钮以外的退出入口，Esc 是最省事的退路。
        // 弹窗（Radix）吃掉的那次不算：关掉历史版本对话框不该连带退出专注。
        const st = useSettingsStore.getState();
        if (!e.defaultPrevented && st.focusMode && s.route === "workspace") {
          e.preventDefault();
          st.setFocusMode(false);
          return;
        }
        requestEscapeClose();
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return;
      const { combos } = useShortcutsStore.getState();
      // 切换标签页：方向由 Shift 决定，故比较时忽略 Shift
      const tab = combos.switchTab;
      if (combo.key === tab.key && combo.ctrl === tab.ctrl && combo.alt === tab.alt) {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (comboEquals(combo, combos.commandPalette) || comboEquals(combo, combos.quickOpen)) {
        // 两者是同义别名：quickOpen 走 commandPalette 的同一实现
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        if (s.paletteOpen) s.closePalette();
        else s.openPalette();
        return;
      }
      if (comboEquals(combo, combos.closeTab)) {
        // 关闭当前标签：preventDefault 尽力拦下 WebView2 的窗口关闭；
        // 若个别环境仍在 native 层先处理，App 的 onCloseRequested 兜底会走「冲刷+确认」而不是直接退出
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        if (s.currentViewId) s.closeTab(s.currentViewId);
        return;
      }
      if (comboEquals(combo, combos.reopenClosedTab)) {
        e.preventDefault();
        useWorkspaceStore.getState().reopenLastClosed();
        return;
      }
      if (comboEquals(combo, combos.goBack)) {
        e.preventDefault();
        useWorkspaceStore.getState().navigateBack();
        return;
      }
      if (comboEquals(combo, combos.goForward)) {
        e.preventDefault();
        useWorkspaceStore.getState().navigateForward();
        return;
      }
      if (comboEquals(combo, combos.search)) {
        e.preventDefault();
        useWorkspaceStore.getState().openSearch("");
        return;
      }
      if (comboEquals(combo, combos.newPage)) {
        e.preventDefault();
        void useWorkspaceStore.getState().createView({ parentId: null, layout: "document" });
        return;
      }
      // 打开/关闭设置：与侧边栏齿轮按钮同义（再按一次回到工作区）
      if (comboEquals(combo, combos.openSettings)) {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        s.setRoute(s.route === "settings" ? "workspace" : "settings");
        return;
      }
      if (comboEquals(combo, combos.toggleTheme)) {
        e.preventDefault();
        const s = useSettingsStore.getState();
        s.setTheme(s.theme === "dark" ? "light" : "dark");
        return;
      }
      if (comboEquals(combo, combos.aiPanel)) {
        e.preventDefault();
        useAiStore.getState().toggle();
        return;
      }
      // 三种编辑器模式：与命令面板、设置页里的开关共用同一个 store
      if (comboEquals(combo, combos.toggleReadonly)) {
        e.preventDefault();
        const st = useSettingsStore.getState();
        st.setEditorReadonly(!st.editorReadonly);
        return;
      }
      if (comboEquals(combo, combos.toggleTypewriter)) {
        e.preventDefault();
        const st = useSettingsStore.getState();
        st.setTypewriter(!st.typewriter);
        return;
      }
      if (comboEquals(combo, combos.toggleFocus)) {
        // 专注模式只在工作区有意义：其它页面上开着，等于把自己关进没有侧边栏的死角
        if (useWorkspaceStore.getState().route !== "workspace") return;
        e.preventDefault();
        const st = useSettingsStore.getState();
        st.setFocusMode(!st.focusMode);
        return;
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

  // 原生菜单栏项（Rust 侧 emit 同名事件，见 src-tauri/src/desktop.rs）→ 现成前端动作
  useEffect(() => {
    const handlers: Record<string, () => void> = {
      "menu:new-page": () => {
        void useWorkspaceStore.getState().createView({ parentId: null, layout: "document" });
      },
      "menu:settings": () => useWorkspaceStore.getState().setRoute("settings"),
      "menu:palette": () => useWorkspaceStore.getState().openPalette(),
    };
    const unlisteners = Object.entries(handlers).map(([event, handler]) => listen(event, handler));
    return () => {
      for (const p of unlisteners) void p.then((un) => un());
    };
  }, []);

  // tsflowy:// 深链：冷启动拉取启动 URL、热启动监听事件；树未加载完先排队（见 lib/deep-link.ts）
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void setupDeepLink()
      .then((d) => {
        if (cancelled) d();
        else dispose = d;
      })
      .catch((e: unknown) => logger.warn("App.deepLink", "deep link setup failed", e));
    return () => {
      cancelled = true;
      dispose?.();
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
  const splitView = splitViewId ? findNode(tree, splitViewId) : null;

  // 外壳级兜底：内容区有 RouteErrorBoundary（切页自动重置），Sidebar/AiPanel/浮层在其覆盖之外——
  // 这里再包一层，任何一处渲染崩溃都显示可重试的兜底 UI，而不是整窗白屏（App 本体不卸载，快捷键/关窗落盘仍生效）
  return (
    <div className="h-screen">
      <RouteErrorBoundary resetKey="app-shell">
        <div className="flex h-full overflow-hidden">
          {!focusChrome && <Sidebar />}
          <div className="flex min-w-0 flex-1 flex-col">
            <RouteErrorBoundary resetKey={`${route}:${currentViewId ?? ""}:${splitViewId ?? ""}`}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                    {t("app.loading")}
                  </div>
                }
              >
                {route === "trash" ? (
                  <TrashPage />
                ) : route === "search" ? (
                  <SearchResultsPage />
                ) : route === "settings" ? (
                  <SettingsPage />
                ) : (
                  <>
                    {!focusChrome && <TabBar />}
                    {splitView ? (
                      <SplitView left={view} right={splitView} hasTabs={!focusChrome} />
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col" {...tabPanel(view?.id ?? null, !focusChrome)}>
                        {renderView(view)}
                      </div>
                    )}
                  </>
                )}
              </Suspense>
            </RouteErrorBoundary>
          </div>
          {!focusChrome && <AiPanel />}
          {focusChrome && (
            // 外壳全藏了，得留一个看得见、点得动的出口（Esc 是同义入口）
            <button
              type="button"
              onClick={() => useSettingsStore.getState().setFocusMode(false)}
              className="fixed right-3 top-3 z-40 flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white/90 px-2.5 py-1 text-[11px] text-neutral-500 shadow-sm hover:bg-neutral-50 hover:text-neutral-700"
            >
              {t("focus.exit")}
              <kbd className="rounded border border-neutral-200 px-1 text-[10px] text-neutral-400">Esc</kbd>
            </button>
          )}
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
      </RouteErrorBoundary>
    </div>
  );
}

export default App;
