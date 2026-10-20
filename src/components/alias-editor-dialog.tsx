import { useEffect, useMemo, useState } from "react";
import { BookMarked, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { parseViewAliases, type View } from "@/types/models";
import { t } from "@/lib/i18n";

interface AliasEditorDialogProps {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 页面别名编辑：这页除名字外的其它叫法（缩写、旧名、英文名）。
 * 只影响「能被哪些名字找到」——链接与反链一律仍按页面 id 走，改名也不会动别名。
 */
export function AliasEditorDialog({ view, open, onOpenChange }: AliasEditorDialogProps) {
  const tree = useWorkspaceStore((s) => s.tree);
  const setViewAliases = useWorkspaceStore((s) => s.setViewAliases);
  const [draft, setDraft] = useState("");

  const selected = useMemo(
    () => [
      ...new Set(
        parseViewAliases(view?.aliases)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ],
    [view],
  );

  // 其它页面已经用过的别名：同一叫法在两个页面上都挂，搜索会同时命中，值得提示出来
  const usedByOthers = useMemo(() => {
    const set = new Set<string>();
    for (const v of flattenTree(tree)) {
      if (v.id === view?.id) continue;
      for (const a of parseViewAliases(v.aliases)) set.add(a);
    }
    return set;
  }, [tree, view]);

  useEffect(() => setDraft(""), [open]);

  if (!view) return null;

  const apply = (aliases: string[]) => void setViewAliases(view.id, aliases);

  const add = (raw: string) => {
    const alias = raw.trim();
    if (!alias || selected.includes(alias)) return;
    apply([...selected, alias]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookMarked className="h-4 w-4" />
            {t("alias.editorTitle")}
          </DialogTitle>
          <DialogDescription className="truncate">{view.name}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[36px] flex-wrap gap-1.5 rounded-md border border-neutral-300 p-1.5">
          {selected.length === 0 && <span className="px-1 text-xs text-neutral-400">{t("alias.emptyHint")}</span>}
          {selected.map((alias) => (
            <span
              key={alias}
              className={
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs " +
                (usedByOthers.has(alias) ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-700")
              }
            >
              {alias}
              <button className="hover:text-destructive" onClick={() => apply(selected.filter((x) => x !== alias))}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            autoFocus
            className="min-w-[100px] flex-1 bg-transparent px-1 text-xs outline-none"
            placeholder={t("alias.inputPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(draft);
                setDraft("");
              }
              if (e.key === "Backspace" && !draft && selected.length > 0) {
                apply(selected.slice(0, -1));
              }
            }}
          />
        </div>

        <p className="text-xs leading-relaxed text-neutral-500">{t("alias.hint")}</p>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
