import { useMemo, useState } from "react";
import { Check, Palette, Pencil, Tags, Trash2, X } from "lucide-react";
import { parseViewTags } from "@/types/models";
import { flattenTree } from "@/lib/tree";
import { TAG_COLORS, tagColor, tagTint } from "@/lib/tags";
import { useWorkspaceStore } from "@/stores/workspace";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";

interface TagPanelProps {
  /** 点标签开始过滤后回调：由侧边栏切回页面树 Tab 展示过滤结果 */
  onFilter: () => void;
}

/** 标签面板：全库标签一览（色点 / 名称 / 页面数）。
 *  点击行 = 按标签过滤页面树；行尾可改色、重命名、删除（均为全局操作）。 */
export function TagPanel({ onFilter }: TagPanelProps) {
  const tree = useWorkspaceStore((s) => s.tree);
  const tagMeta = useWorkspaceStore((s) => s.tagMeta);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const setTagColor = useWorkspaceStore((s) => s.setTagColor);
  const renameTag = useWorkspaceStore((s) => s.renameTag);
  const deleteTag = useWorkspaceStore((s) => s.deleteTag);

  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const v of flattenTree(tree)) {
      for (const tag of parseViewTags(v.tags)) count.set(tag, (count.get(tag) ?? 0) + 1);
    }
    return [...count.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, n]) => ({ name, count: n }));
  }, [tree]);

  const [colorFor, setColorFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const startRename = (name: string) => {
    setEditing(name);
    setDraft(name);
  };

  const commitRename = (from: string) => {
    void renameTag(from, draft);
    setEditing(null);
  };

  const applyFilter = (name: string) => {
    const on = tagFilter === name;
    setTagFilter(on ? null : name);
    if (!on) onFilter();
  };

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      {tags.length === 0 ? (
        <div className="px-2 py-3 text-center text-xs text-neutral-500">{t("tag.panel.empty")}</div>
      ) : (
        <ul className="pt-1">
          {tags.map(({ name, count }) => {
            const color = tagColor(name, tagMeta);
            const on = tagFilter === name;
            return (
              <li key={name} className="relative">
                {editing === name ? (
                  <div className="flex items-center gap-1 px-1 py-0.5">
                    <input
                      autoFocus
                      className="h-[26px] min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 text-[12px] outline-none focus:border-brand-500"
                      placeholder={t("tag.renamePlaceholder")}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(name);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <button
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                      title={t("common.done")}
                      onClick={() => commitRename(name)}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                      title={t("common.cancel")}
                      onClick={() => setEditing(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div
                    className={
                      "group flex h-[30px] items-center gap-1 rounded px-1 " +
                      (on ? "bg-neutral-300/50" : "hover:bg-neutral-300/40")
                    }
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={t("tag.filterHint")}
                      onClick={() => applyFilter(name)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span
                        className={"min-w-0 flex-1 truncate text-[13px] " + (on ? "text-brand-700" : "text-neutral-700")}
                      >
                        {name}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-400" title={t("tag.count", { n: count })}>
                        {count}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                        title={t("tag.changeColor")}
                        onClick={() => setColorFor(colorFor === name ? null : name)}
                      >
                        <Palette className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                        title={t("tag.rename")}
                        onClick={() => startRename(name)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-destructive"
                        title={t("tag.delete")}
                        onClick={() => setPendingDelete(name)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* 取色面板 */}
                {colorFor === name && (
                  <div className="absolute right-1 z-10 mt-1 flex w-[124px] flex-wrap gap-1.5 rounded-md border border-neutral-300 bg-white p-2 shadow-md">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        className="h-4 w-4 rounded-full ring-neutral-400 ring-offset-1 hover:ring-2"
                        style={{
                          backgroundColor: c,
                          ...(c === color ? { boxShadow: `0 0 0 2px ${tagTint(c, "66")}` } : {}),
                        }}
                        title={c}
                        onClick={() => {
                          void setTagColor(name, c);
                          setColorFor(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t("tag.confirmDeleteTitle")}
        description={pendingDelete ? t("tag.confirmDeleteDesc", { tag: pendingDelete }) : undefined}
        onConfirm={() => {
          if (pendingDelete) void deleteTag(pendingDelete);
        }}
      />

      {tags.length > 0 && (
        <div className="flex items-center gap-1 px-1 pt-2 text-[11px] text-neutral-400">
          <Tags className="h-3 w-3" />
          {t("tag.filterHint")}
        </div>
      )}
    </div>
  );
}