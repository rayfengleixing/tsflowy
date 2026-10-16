import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDbStore } from "@/stores/database-context";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

// 表格行回收站（与页面回收站同一套软删约定）：删行只是打标记，
// 这里给出恢复 / 彻底删除 / 清空三个出口。超过保留期的行由全局小时级定时器自动清掉。

export function RowTrashDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trash = useDbStore((s) => s.trash);
  const loadTrash = useDbStore((s) => s.loadTrash);
  const restoreRow = useDbStore((s) => s.restoreRow);
  const purgeRow = useDbStore((s) => s.purgeRow);
  const purgeTrash = useDbStore((s) => s.purgeTrash);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);

  const fail = (where: string, e: unknown) => {
    logger.error(where, e);
    toast.error(t("error.db", { message: String(e) }));
  };
  const run = (action: Promise<unknown>, where: string): void => {
    void action.catch((e: unknown) => fail(where, e));
  };

  // 每次打开都重新拉：行删/恢复可能在别的窗口发生，列表不缓存
  useEffect(() => {
    if (!open) return;
    loadTrash().catch((e: unknown) => {
      logger.error("load row trash failed", e);
      toast.error(t("error.db", { message: String(e) }));
    });
  }, [open, loadTrash]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("row.trashTitle")}</DialogTitle>
            <DialogDescription>{t("row.trashDesc")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto">
            {trash.length === 0 ? (
              <div className="py-8 text-center text-sm text-neutral-500">{t("trash.empty")}</div>
            ) : (
              <ul className="space-y-1">
                {trash.map((row) => (
                  <li
                    key={row.id}
                    data-row-trash-id={row.id}
                    className="flex h-9 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">
                      {row.title || t("row.trashUntitled")}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {t("trash.deletedAt", {
                        date: row.deleted_at ? new Date(row.deleted_at).toLocaleString() : "?",
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[12px]"
                      onClick={() => run(restoreRow(row.id), "restore row failed")}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      {t("trash.restore")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[12px] text-destructive hover:text-destructive"
                      onClick={() => setPurgeTarget(row.id)}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      {t("trash.purge")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {trash.length > 0 && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setPurgeAllOpen(true)}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {t("trash.purgeAll")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={purgeTarget !== null}
        onOpenChange={(v) => {
          if (!v) setPurgeTarget(null);
        }}
        title={t("trash.purge")}
        description={t("row.trashPurgeDesc")}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          const id = purgeTarget;
          setPurgeTarget(null);
          if (id) run(purgeRow(id), "purge row failed");
        }}
      />

      <ConfirmDialog
        open={purgeAllOpen}
        onOpenChange={setPurgeAllOpen}
        title={t("trash.purgeAll")}
        description={t("row.trashPurgeAllDesc", { count: String(trash.length) })}
        confirmLabel={t("common.delete")}
        onConfirm={() =>
          run(
            purgeTrash().then((n) => toast.success(t("row.trashPurged", { count: String(n) }))),
            "purge row trash failed",
          )
        }
      />
    </>
  );
}
