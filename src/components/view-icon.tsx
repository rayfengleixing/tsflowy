import type { ReactNode } from "react";
import { Calendar, CalendarRange, FileText, FormInput, Images, Kanban, List, Table } from "lucide-react";
import type { LayoutType } from "@/types/models";
import { t } from "@/lib/i18n";

/** 布局 → 图标/文案（侧边栏、标签栏、占位页共用） */
export function layoutMeta(layout: LayoutType): { icon: ReactNode; label: string } {
  const size = "h-4 w-4";
  switch (layout) {
    case "document":
      return { icon: <FileText className={size} />, label: t("layout.document") };
    case "grid":
      return { icon: <Table className={size} />, label: t("layout.grid") };
    case "board":
      return { icon: <Kanban className={size} />, label: t("layout.board") };
    case "calendar":
      return { icon: <Calendar className={size} />, label: t("layout.calendar") };
    case "timeline":
      return { icon: <CalendarRange className={size} />, label: t("layout.timeline") };
    case "list":
      return { icon: <List className={size} />, label: t("layout.list") };
    case "gallery":
      return { icon: <Images className={size} />, label: t("layout.gallery") };
    case "form":
      return { icon: <FormInput className={size} />, label: t("layout.form") };
  }
}

/** 视图图标：优先 emoji，否则按布局 */
export function viewIcon(view: { icon: string | null; layout: LayoutType }): ReactNode {
  if (view.icon) return <span className="text-[13px] leading-none">{view.icon}</span>;
  return layoutMeta(view.layout).icon;
}
