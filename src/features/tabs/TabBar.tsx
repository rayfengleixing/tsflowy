import { useRef } from "react";
import { Download, FileText, Image as ImageIcon, Plus, Printer, X } from "lucide-react";
import { toast } from "sonner";
import { viewIcon } from "@/components/view-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { exportPage, exportPageImage, printPage } from "@/lib/export-page";
import { flushAllForClose } from "@/lib/close-flush";
import type { View } from "@/types/models";

/** 顶部标签栏（说明书 6.4：高 40px、标签宽 200px、可切换/关闭/拖拽排序） */
export function TabBar() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const openView = useWorkspaceStore((s) => s.openView);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const newTab = useWorkspaceStore((s) => s.newTab);
  const reorderTabs = useWorkspaceStore((s) => s.reorderTabs);
  const dragIndex = useRef<number | null>(null);
  const currentView = tabs.find((v: View) => v.id === currentViewId) ?? null;

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

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
      {tabs.map((v: View, index: number) => {
        const active = v.id === currentViewId;
        return (
          <div
            key={v.id}
            data-tab-id={v.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onClick={() => openView(v.id)}
            className={
              "group relative flex w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-neutral-300 px-2 text-[13px] " +
              (active ? "bg-white text-neutral-800" : "text-neutral-500 hover:bg-neutral-200/60")
            }
          >
            {active && <div className="absolute inset-x-0 top-0 h-[2px] bg-brand-500" />}
            <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            <button
              data-testid="tab-close"
              className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300 group-hover:flex"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(v.id);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        data-testid="new-tab"
        className="flex w-8 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-200/60"
        title={t("tabs.newTab")}
        onClick={() => newTab()}
      >
        <Plus className="h-4 w-4" />
      </button>
      {currentView?.layout === "document" && (
        <div className="ml-auto flex shrink-0 items-center pr-1.5">
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
        </div>
      )}
    </div>
  );
}
