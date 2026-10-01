import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Palette, Pencil, Tags, Trash2, X } from "lucide-react";
import { parseViewTags } from "@/types/models";
import { flattenTree } from "@/lib/tree";
import { TAG_COLORS, buildTagTree, tagColor, tagTint, type TagTreeNode } from "@/lib/tags";
import { useWorkspaceStore } from "@/stores/workspace";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";

interface TagPanelProps {
  /** 点标签开始过滤后回调：由侧边栏切回页面树 Tab 展示过滤结果 */
  onFilter: () => void;
}

/** 标签面板：全库标签一览（色点 / 名称 / 页面数），按「/」分层折叠。
 *  点击行 = 按标签（含子标签）过滤页面树；行尾可改色、重命名、删除（均为全局操作）。 */
export function TagPanel({ onFilter }: TagPanelProps) {
  const tree = useWorkspaceStore((s) => s.tree);
  const tagMeta = useWorkspaceStore((s) => s.tagMeta);
  const tagFilter = useWorkspaceStore((s) => s.tagFilter);
  const setTagFilter = useWorkspaceStore((s) => s.setTagFilter);
  const setTagColor = useWorkspaceStore((s) => s.setTagColor);
  const renameTag = useWorkspaceStore((s) => s.renameTag);
  const deleteTag = useWorkspaceStore((s) => s.deleteTag);

  const tagTree = useMemo(() => {
    const count = new Map<string, number>();
    for (const v of flattenTree(tree)) {
      for (const tag of parseViewTags(v.tags)) count.set(tag, (count.get(tag) ?? 0) + 1);
    }
    return buildTagTree(count.entries());
  }, [tree]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<TagTreeNode | null>(null);

  /** 展开状态展平：只渲染可见行，父行可折叠 */
  const rows = useMemo(() => {
    const out: { node: TagTreeNode; depth: number }[] = [];
    const walk = (ns: TagTreeNode[], depth: number) => {
      for (const n of ns) {
        out.push({ node: n, depth });
        if (n.children.length > 0 && !collapsed.has(n.path)) walk(n.children, depth + 1);
      }
    };
    walk(tagTree, 0);
    return out;
  }, [tagTree, collapsed]);

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const startRename = (path: string) => {
    setEditing(path);
    setDraft(path);
  };

  const commitRename = (from: string) => {
    void renameTag(from, draft);
    setEditing(null);
  };

  const applyFilter = (path: string) => {
    const on = tagFilter === path;
    setTagFilter(on ? null : path);
    if (!on) onFilter();
  };

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      {rows.length === 0 ? (
        <div className="px-2 py-3 text-center text-xs text-neutral-500">{t("tag.panel.empty")}</div>
      ) : (
        <ul className="pt-1">
          {rows.map(({ node, depth }) => {
            const { path, label, total, children } = node;
            const color = tagColor(path, tagMeta);
            const on = tagFilter === path;
            const open = !collapsed.has(path);
            return (
              <li key={path} className="relative">
                {editing === path ? (
                  <div className="flex items-center gap-1 px-1 py-0.5" style={{ paddingLeft: depth * 12 + 4 }}>
                    <input
                      autoFocus
                      className="h-[26px] min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 text-[12px] outline-none focus:border-brand-500"
                      placeholder={t("tag.renamePlaceholder")}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(path);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <button
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                      title={t("common.done")}
                      onClick={() => commitRename(path)}
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
                      "group flex h-[30px] items-center gap-1 rounded pr-1 " +
                      (on ? "bg-neutral-300/50" : "hover:bg-neutral-300/40")
                    }
                    style={{ paddingLeft: depth * 12 + 2 }}
                  >
                    {children.length > 0 ? (
                      <button
                        className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-300/60 hover:text-neutral-700"
                        title={open ? t("tag.collapse") : t("tag.expand")}
                        onClick={() => toggleCollapse(path)}
                      >
                        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <button
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={t("tag.filterHint")}
                      onClick={() => applyFilter(path)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span
                        className={"min-w-0 flex-1 truncate text-[13px] " + (on ? "text-brand-700" : "text-neutral-700")}
                      >
                        {label}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-400" title={t("tag.count", { n: total })}>
                        {total}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                        title={t("tag.changeColor")}
                        onClick={() => setColorFor(colorFor === path ? null : path)}
                      >
                        <Palette className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-800"
                        title={t("tag.rename")}
                        onClick={() => startRename(path)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300/60 hover:text-destructive"
                        title={t("tag.delete")}
                        onClick={() => setPendingDelete(node)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* 取色面板 */}
                {colorFor === path && (
                  <div
                    className="absolute right-1 z-10 mt-1 flex w-[124px] flex-wrap gap-1.5 rounded-md border border-neutral-300 bg-white p-2 shadow-md"
                    style={{ marginLeft: depth * 12 }}
                  >
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
                          void setTagColor(path, c);
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
        description={
          pendingDelete
            ? pendingDelete.children.length > 0
              ? t("tag.confirmDeleteDescTree", { tag: pendingDelete.path })
              : t("tag.confirmDeleteDesc", { tag: pendingDelete.path })
            : undefined
        }
        onConfirm={() => {
          if (pendingDelete) void deleteTag(pendingDelete.path);
        }}
      />

      {rows.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1 pt-2 text-[11px] text-neutral-400">
          <span className="flex items-center gap-1">
            <Tags className="h-3 w-3" />
            {t("tag.filterHint")}
          </span>
          <span>{t("tag.hierHint")}</span>
        </div>
      )}
    </div>
  );
}