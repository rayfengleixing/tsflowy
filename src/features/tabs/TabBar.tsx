import { useRef } from "react";
import {
  CircleX,
  Columns2,
  Download,
  FileText,
  Image as ImageIcon,
  Lock,
  Plus,
  Printer,
  Sparkles,
  SquareX,
  Unlock,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { viewIcon } from "@/components/view-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useWorkspaceStore } from "@/stores/workspace";
import { useAiStore } from "@/stores/ai";
import { useShortcutsStore, formatCombo } from "@/lib/shortcuts";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { exportPage, exportPageImage, printPage } from "@/lib/export-page";
import { flushAllForClose } from "@/lib/close-flush";
import type { View } from "@/types/models";

/**
 * tab ↔ tabpanel 配对用的 DOM id：主内容区在 App.tsx，两边必须用同一套拼法，
 * 否则 aria-controls / aria-labelledby 会指向不存在的元素（读屏器直接放弃这条关系）。
 */
export const tabDomId = (viewId: string) => `tab-${viewId}`;
export const panelDomId = (viewId: string) => `panel-${viewId}`;

/** 顶部标签栏（说明书 6.4：高 40px、标签宽 200px、可切换/关闭/拖拽排序） */
export function TabBar() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const pinnedTabIds = useWorkspaceStore((s) => s.pinnedTabIds);
  const openView = useWorkspaceStore((s) => s.openView);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeAllTabs = useWorkspaceStore((s) => s.closeAllTabs);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const togglePinTab = useWorkspaceStore((s) => s.togglePinTab);
  const newTab = useWorkspaceStore((s) => s.newTab);
  const reorderTabs = useWorkspaceStore((s) => s.reorderTabs);
  const splitViewId = useWorkspaceStore((s) => s.splitViewId);
  const openInSplit = useWorkspaceStore((s) => s.openInSplit);
  const closeSplit = useWorkspaceStore((s) => s.closeSplit);
  const dragIndex = useRef<number | null>(null);
  const currentView = tabs.find((v: View) => v.id === currentViewId) ?? null;
  const aiOpen = useAiStore((s) => s.open);
  const toggleAi = useAiStore((s) => s.toggle);
  const aiCombo = useShortcutsStore((s) => s.combos.aiPanel);

  // 并排开关：已并排则取消；未并排时把「当前标签的下一个」放到右栏，一键形成对照
  const toggleSplit = () => {
    if (splitViewId) {
      closeSplit();
      return;
    }
    if (!currentViewId || tabs.length < 2) return;
    const idx = tabs.findIndex((v) => v.id === currentViewId);
    openInSplit(tabs[(idx + 1) % tabs.length].id);
  };

  // 当前页导出：Markdown（先冲刷防抖中的编辑）/ 长图 PNG / PDF（系统打印对话框另存为）
  const handleExport = async (kind: "markdown" | "image" | "pdf") => {
    if (!currentView) return;
    try {
      if (kind === "markdown") {
        await flushAllForClose();
        await exportPage(currentView.id, currentView.name, "markdown");
      } else if (kind === "image") {
        await exportPageImage(currentView.name);
      } else {
        await printPage();
      }
    } catch (e) {
      logger.error("tabs.export", e);
      toast.error(t("tree.exportFailed", { message: String(e) }));
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndex.current = index;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    if (dragIndex.current === null) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const to = before ? index : index + 1;
    const from = dragIndex.current;
    if (from !== index && to !== from && to !== from + 1) {
      reorderTabs(from, to);
      dragIndex.current = to > from ? to - 1 : to;
    }
  };

  const tabRefs = useRef(new Map<string, HTMLDivElement | null>());

  /**
   * 键盘导航走 tablist 的「手动激活」：←/→ 只在标签间移焦点，Home/End 到首末，
   * Enter/空格才真的打开。方向键不直接切页是因为 openView 要整篇载入文档，
   * 长按方向键边挪焦点边加载会在多标签时明显卡顿。
   */
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openView(tabs[index].id);
      return;
    }
    const last = tabs.length - 1;
    let to = -1;
    if (e.key === "ArrowRight") to = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") to = index === 0 ? last : index - 1;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = last;
    if (to < 0 || to > last) return;
    e.preventDefault();
    tabRefs.current.get(tabs[to].id)?.focus();
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
      <div role="tablist" aria-label={t("tabs.list")} className="flex min-w-0 flex-1 items-stretch">
        {tabs.map((v: View, index: number) => {
          const active = v.id === currentViewId;
          const pinned = pinnedTabIds.has(v.id);
          return (
            <ContextMenu key={v.id}>
              <ContextMenuTrigger asChild>
                <div
                  data-tab-id={v.id}
                  id={tabDomId(v.id)}
                  aria-controls={panelDomId(v.id)}
                  ref={(el) => {
                    if (el) tabRefs.current.set(v.id, el);
                    else tabRefs.current.delete(v.id);
                  }}
                  role="tab"
                  aria-selected={active}
                  // 漫游 tabindex：Tab 键进标签栏时只落在当前页那一个上（没有当前页时兜底给首个）
                  tabIndex={active || (!currentView && index === 0) ? 0 : -1}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onClick={() => openView(v.id)}
                  className={
                    "group relative flex min-w-0 max-w-[200px] flex-1 cursor-pointer items-center gap-1.5 overflow-hidden border-r border-neutral-300 px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 " +
                    (active ? "bg-white text-neutral-800" : "text-neutral-500 hover:bg-neutral-200/60")
                  }
                >
                  {active && <div className="absolute inset-x-0 top-0 h-[2px] bg-brand-500" />}
                  <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500" aria-hidden="true">
                    {viewIcon(v)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  {pinned ? (
                    <Lock
                      data-testid="tab-pin-indicator"
                      className="h-3 w-3 shrink-0 text-neutral-500"
                      aria-label={t("tabs.pinned")}
                    />
                  ) : null}
                  <button
                    data-testid="tab-close"
                    className="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 hover:bg-neutral-300 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                    aria-label={t("tabs.close")}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(v.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem onSelect={() => togglePinTab(v.id)}>
                  {pinned ? <Unlock className="mr-2 h-3.5 w-3.5" /> : <Lock className="mr-2 h-3.5 w-3.5" />}
                  {pinned ? t("tabs.unpin") : t("tabs.pin")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => closeTab(v.id)}>
                  <X className="mr-2 h-3.5 w-3.5" />
                  {t("tabs.close")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeOtherTabs(v.id)}>
                  <CircleX className="mr-2 h-3.5 w-3.5" />
                  {t("tabs.closeOthers")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => closeAllTabs()}>
                  <SquareX className="mr-2 h-3.5 w-3.5" />
                  {t("tabs.closeAll")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <button
        data-testid="new-tab"
        className="flex w-8 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-200/60"
        title={t("tabs.newTab")}
        onClick={() => newTab()}
      >
        <Plus className="h-4 w-4" />
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-1.5">
        {tabs.length >= 2 && (
          <button
            data-testid="split-toggle"
            className={
              "flex h-7 items-center gap-1 rounded-md px-2 text-[12px] " +
              (splitViewId ? "bg-brand-100 text-brand-700" : "text-neutral-500 hover:bg-neutral-200/70")
            }
            title={splitViewId ? t("split.close") : t("split.openHint")}
            onClick={toggleSplit}
          >
            <Columns2 className="h-3.5 w-3.5" />
            {splitViewId ? t("split.close") : t("split.open")}
          </button>
        )}
        <button
          data-testid="ai-toggle"
          className={
            "flex h-7 items-center gap-1 rounded-md px-2 text-[12px] " +
            (aiOpen ? "bg-brand-100 text-brand-700" : "text-neutral-500 hover:bg-neutral-200/70")
          }
          title={`${t("ai.title")}（${formatCombo(aiCombo)}）`}
          aria-pressed={aiOpen}
          onClick={toggleAi}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("ai.title")}
        </button>
        {currentView?.layout === "document" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-testid="page-export"
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-neutral-500 hover:bg-neutral-200/70"
                title={t("tabs.export")}
              >
                <Download className="h-3.5 w-3.5" />
                {t("tabs.export")}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => void handleExport("markdown")}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                {t("tree.exportMd")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleExport("image")}>
                <ImageIcon className="mr-2 h-3.5 w-3.5" />
                {t("tree.exportPng")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleExport("pdf")}>
                <Printer className="mr-2 h-3.5 w-3.5" />
                {t("tree.exportPdf")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
