import { useEffect, useState } from "react";
import { FolderInput } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { viewApi } from "@/lib/backend/db";
import { logger } from "@/lib/logger";
import { moveDestinations, type MoveDestination } from "@/lib/doc/tree";
import { t } from "@/lib/i18n";
import { useWorkspaceStore } from "@/stores/workspace";
import type { View } from "@/types/models";

interface MoveToSpaceDialogProps {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 把页面搬到另一个空间：先选空间，再选挂在它的哪个页面下（或空间根级）。
 * 落点清单每次打开都重取一次 —— 别的空间随时可能被人改过树。
 */
export function MoveToSpaceDialog({ view, open, onOpenChange }: MoveToSpaceDialogProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const moveViewToWorkspace = useWorkspaceStore((s) => s.moveViewToWorkspace);

  const targets = workspaces.filter((w) => w.id !== currentWorkspaceId);
  const [pickedSpace, setPickedSpace] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<MoveDestination[]>([]);
  const [busy, setBusy] = useState(false);

  // 每次打开都回到「第一个其它空间 + 挂根级」：上次选的空间可能已被删掉
  useEffect(() => {
    if (!open) return;
    setPickedSpace("");
    setParentId(null);
  }, [open]);

  const space = targets.find((w) => w.id === pickedSpace) ?? targets[0];
  const spaceId = space.id;

  useEffect(() => {
    let alive = true;
    void viewApi
      .listByWorkspace(spaceId)
      .then((rows) => {
        if (alive) setDestinations(moveDestinations(rows));
      })
      .catch((e: unknown) => {
        logger.warn("MoveToSpaceDialog", "list destination workspace failed", spaceId, e);
        if (alive) setDestinations([]);
      });
    return () => {
      alive = false;
    };
  }, [spaceId]);

  if (!view) return null;

  const apply = async () => {
    setBusy(true);
    try {
      await moveViewToWorkspace(view.id, spaceId, parentId);
      onOpenChange(false);
    } catch (e) {
      // 回收站里的页面、派生视图、父级不属于目标空间这些守卫都在 Rust 的错误消息里，不另翻一份文案
      logger.warn("MoveToSpaceDialog", "move page across workspaces failed", view.id, e);
      toast.error(t("moveToSpace.failed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-4 w-4" />
            {t("moveToSpace.title")}
          </DialogTitle>
          <DialogDescription className="truncate">{view.name}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          {targets.map((w) => (
            <Button
              key={w.id}
              size="sm"
              variant={w.id === spaceId ? "default" : "outline"}
              data-testid="move-target-space"
              onClick={() => {
                setPickedSpace(w.id);
                setParentId(null);
              }}
            >
              {w.name}
            </Button>
          ))}
        </div>

        <div className="max-h-[240px] overflow-y-auto rounded-md border border-neutral-200">
          {destinations.map((d) => (
            <button
              key={d.parentId ?? "__root__"}
              data-testid="move-target-parent"
              className={
                "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm " +
                (d.parentId === parentId ? "bg-neutral-100 font-medium" : "hover:bg-neutral-50")
              }
              style={{ paddingLeft: `${8 + d.depth * 16}px` }}
              onClick={() => setParentId(d.parentId)}
            >
              {d.parentId === null ? t("moveToSpace.rootLevel", { space: space.name }) : d.name}
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-neutral-500">{t("moveToSpace.hint")}</p>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={busy} data-testid="move-confirm" onClick={() => void apply()}>
            {t("moveToSpace.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
