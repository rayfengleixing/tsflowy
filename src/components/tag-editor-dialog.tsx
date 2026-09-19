import { useEffect, useMemo, useState } from "react";
import { Tag, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { parseViewTags, type View } from "@/types/models";
import { t } from "@/lib/i18n";

interface TagEditorDialogProps {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 页面标签编辑：勾选已有标签 / 输入新标签回车添加 / × 移除 */
export function TagEditorDialog({ view, open, onOpenChange }: TagEditorDialogProps) {
  const tree = useWorkspaceStore((s) => s.tree);
  const setViewTags = useWorkspaceStore((s) => s.setViewTags);
  const [draft, setDraft] = useState("");

  const selected = useMemo(() => parseViewTags(view?.tags), [view]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const v of flattenTree(tree)) for (const tag of parseViewTags(v.tags)) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tree]);

  useEffect(() => setDraft(""), [open]);

  if (!view) return null;

  const apply = (tags: string[]) => void setViewTags(view.id, tags);

  const add = (raw: string) => {
    const tag = raw.trim();
    if (!tag || selected.includes(tag)) return;
    apply([...selected, tag]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" />
            {t("tag.editorTitle")}
          </DialogTitle>
          <DialogDescription className="truncate">{view.name}</DialogDescription>
        </DialogHeader>

        {/* 已选标签 */}
        <div className="flex min-h-[36px] flex-wrap gap-1.5 rounded-md border border-neutral-300 p-1.5">
          {selected.length === 0 && <span className="px-1 text-xs text-neutral-400">{t("tag.emptyHint")}</span>}
          {selected.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-neutral-700"
            >
              {tag}
              <button
                className="text-neutral-400 hover:text-destructive"
                onClick={() => apply(selected.filter((x) => x !== tag))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            autoFocus
            className="min-w-[100px] flex-1 bg-transparent px-1 text-xs outline-none"
            placeholder={t("tag.inputPlaceholder")}
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

        {/* 全库已有标签：点击快速添加/移除 */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => {
              const on = selected.includes(tag);
              return (
                <button
                  key={tag}
                  className={
                    "rounded-full border px-2 py-0.5 text-xs transition " +
                    (on
                      ? "border-brand-500 bg-brand-100 text-brand-700"
                      : "border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-700")
                  }
                  onClick={() => (on ? apply(selected.filter((x) => x !== tag)) : add(tag))}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
