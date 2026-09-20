import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus } from "lucide-react";
import type { LayoutType } from "@/types/models";
import { LAYOUTS } from "@/types/models";
import { layoutMeta } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

interface NewPageMenuProps {
  parentId?: string | null;
  align?: "start" | "end";
  triggerClassName?: string;
  children?: React.ReactNode;
}

/** 新建页面菜单：四种布局（侧边栏新建按钮 / 页面行 "+" 子页面共用） */
export function NewPageMenu({ parentId = null, align = "start", triggerClassName, children }: NewPageMenuProps) {
  const createView = useWorkspaceStore((s) => s.createView);

  const handleCreate = (layout: LayoutType) => {
    createView({ parentId, layout }).catch((e: unknown) => {
      logger.error("create view failed", e);
      toast.error(t("error.db", { message: String(e) }));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children ?? (
          <button
            className={
              "flex h-[30px] w-full items-center gap-1.5 rounded-md px-2 text-[13px] text-neutral-600 hover:bg-neutral-300/60 " +
              (triggerClassName ?? "")
            }
          >
            <Plus className="h-4 w-4" />
            {t("sidebar.newPage")}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        {LAYOUTS.filter((l) => l === "document" || l === "grid").map((layout) => (
          <DropdownMenuItem key={layout} onSelect={() => handleCreate(layout)}>
            <span className="mr-2 text-neutral-500">{layoutMeta(layout).icon}</span>
            {layoutMeta(layout).label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
