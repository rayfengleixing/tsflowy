import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { documentApi, type SnapshotRow } from "@/lib/documents";
import { useWorkspaceStore } from "@/stores/workspace";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

interface HistoryDialogProps {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `${t("history.today")} ${time}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${time}`;
}

/** 历史版本：快照列表（新→旧）+ 一键恢复。保存时每 10 分钟自动落一份，每页保留 50 份。 */
export function HistoryDialog({ view, open, onOpenChange }: HistoryDialogProps) {
  const reload = useWorkspaceStore((s) => s.reload);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !view) return;
    setLoading(true);
    documentApi
      .listSnapshots(view.id)
      .then(setSnapshots)
      .catch((e) => {
        console.error("list snapshots failed", e);
        toast.error(t("error.db", { message: String(e) }));
      })
      .finally(() => setLoading(false));
  }, [open, view]);

  if (!view) return null;

  const restore = async (id: number) => {
    setRestoring(id);
    try {
      await documentApi.restoreSnapshot(id);
      await reload();
      toast.success(t("history.restored"));
      onOpenChange(false);
    } catch (e) {
      console.error("restore snapshot failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("history.title")}
          </DialogTitle>
          <DialogDescription className="truncate">{view.name}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[360px] overflow-y-auto">
          {loading && <div className="py-6 text-center text-xs text-neutral-400">{t("history.loading")}</div>}
          {!loading && snapshots.length === 0 && (
            <div className="py-6 text-center text-xs text-neutral-400">{t("history.empty")}</div>
          )}
          {snapshots.map((snap) => (
            <div
              key={snap.id}
              className="flex items-center justify-between gap-2 border-b border-neutral-100 px-1 py-2 last:border-0"
            >
              <div className="min-w-0">
                <div className="text-[13px] text-neutral-700">{formatTime(snap.created_at)}</div>
                <div className="text-[11px] text-neutral-400">
                  {snap.reason === "pre_restore" ? t("history.preRestore") : t("history.auto")}
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={restoring !== null} onClick={() => void restore(snap.id)}>
                {restoring === snap.id ? (
                  t("history.restoring")
                ) : (
                  <>
                    <RotateCcw className="mr-1 h-3 w-3" />
                    {t("history.restore")}
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-neutral-400">{t("history.hint")}</p>
      </DialogContent>
    </Dialog>
  );
}
