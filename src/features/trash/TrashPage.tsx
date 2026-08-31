import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw, Trash2 } from "lucide-react";
import { viewIcon } from "@/components/view-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";

/** 回收站页（说明书 5.1：恢复 / 彻底删除 / 清空） */
export function TrashPage() {
  const { trash, restoreView, purgeView, purgeTrash } = useWorkspaceStore();
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);

  const handleRestore = (id: string) => restoreView(id).catch((e) => console.error("restore failed", e));
  const handlePurge = (id: string) => purgeView(id).catch((e) => console.error("purge failed", e));
  const handlePurgeAll = () => purgeTrash().catch((e) => console.error("purge trash failed", e));

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-300 px-4">
        <h1 className="text-sm font-medium text-neutral-800">{t("trash.title")}</h1>
        {trash.length > 0 && (
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setPurgeAllOpen(true)}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t("trash.purgeAll")}
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {trash.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("trash.empty")}</div>
        ) : (
          <ul className="space-y-1">
            {trash.map((v) => (
              <li
                key={v.id}
                data-trash-id={v.id}
                className="flex h-[36px] items-center gap-2 rounded-md px-2 text-[13px] hover:bg-neutral-200/60"
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-800">{v.name}</span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {t("trash.deletedAt", { date: v.deleted_at ? new Date(v.deleted_at).toLocaleString() : "?" })}
                </span>
                <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[12px]" onClick={() => handleRestore(v.id)}>
                  <RotateCcw className="mr-1 h-3 w-3" />
                  {t("trash.restore")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[12px] text-destructive hover:text-destructive"
                  onClick={() => setPurgeTarget(v.id)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {t("trash.purge")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!purgeTarget}
        onOpenChange={(o) => !o && setPurgeTarget(null)}
        title={t("trash.purge")}
        confirmLabel={t("trash.purge")}
        onConfirm={() => purgeTarget && handlePurge(purgeTarget)}
      />
      <ConfirmDialog
        open={purgeAllOpen}
        onOpenChange={setPurgeAllOpen}
        title={t("trash.purgeAll")}
        description={t("trash.purgeAllDesc")}
        confirmLabel={t("trash.purgeAll")}
        onConfirm={handlePurgeAll}
      />
    </div>
  );
}
