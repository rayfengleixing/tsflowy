import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import { toast } from "sonner";

/** 空间区（高 32px）：当前空间 + 下拉（切换/新建/重命名/删除当前空间） */
export function SpaceSwitcher() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const current = workspaces.find((w) => w.id === currentWorkspaceId);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleting, setDeleting] = useState(false);

  const submitCreate = async () => {
    const name = newName.trim() || "新空间";
    setCreating(false);
    setNewName("");
    try {
      await createWorkspace(name);
    } catch (e: unknown) {
      console.error("create workspace failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const submitRename = async () => {
    const name = renameName.trim();
    if (!name || !current) return;
    const id = current.id;
    setRenaming(false);
    try {
      await renameWorkspace(id, name);
    } catch (e: unknown) {
      console.error("rename workspace failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  return (
    <>
      <div className="flex h-8 items-center px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-neutral-800 hover:bg-neutral-300/60">
              <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? "…"}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} className="justify-between" onSelect={() => switchWorkspace(w.id)}>
                <span className="truncate">{w.name}</span>
                {w.id === currentWorkspaceId && <Check className="h-3.5 w-3.5 text-brand-500" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t("sidebar.newSpace")}
            </DropdownMenuItem>
            {current && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameName(current.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("workspace.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleting(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("workspace.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 新建空间 */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>{t("sidebar.newSpace")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            placeholder={t("sidebar.newSpace")}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitCreate()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitCreate}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名当前空间 */}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="w-[400px]">
          <DialogHeader>
            <DialogTitle>{t("workspace.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitRename}>{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("workspace.confirmDeleteTitle")}
        description={t("workspace.confirmDeleteDesc", { name: current?.name ?? "" })}
        onConfirm={() => current && deleteWorkspace(current.id)}
      />
    </>
  );
}
