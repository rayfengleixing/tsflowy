// 反链面板：底部固定的可收起区，列出「谁在正文里提到了本页」（从 EditorPage.tsx 原样搬出）。
// 数据也取在这里：viewId 变了就清空重拉，宿主只留一个 <BacklinksPanel />。
import { useEffect, useMemo, useState } from "react";
import { Link2, ChevronDown, ChevronUp } from "lucide-react";

import { mentionsApi, type MentionRow } from "@/lib/mentions";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

interface BacklinksPanelProps {
  /** 本文档的视图 id：反链按它查 */
  viewId: string;
  /** 专注模式下连同外壳一起藏起。只是不渲染，组件仍挂载：收起状态与已拉到的数据都不丢 */
  hidden: boolean;
}

export function BacklinksPanel({ viewId, hidden }: BacklinksPanelProps) {
  const [backlinks, setBacklinks] = useState<MentionRow[]>([]);
  const [backlinkViews, setBacklinkViews] = useState<Map<string, View>>(new Map());
  const [backlinksOpen, setBacklinksOpen] = useState(true);

  // 反链面板：viewId 变化或文档保存后刷新（mentions 表在 scheduleSave→rebuildFor 时已更新）。
  // 切页时先清空旧数据，避免上一个文档的反链短暂残留。
  useEffect(() => {
    let alive = true;
    setBacklinks([]);
    setBacklinkViews(new Map());
    if (!viewId) return;
    // listBacklinks 的 JOIN 已带出来源视图完整行，无需再逐条 viewApi.get
    void mentionsApi.listBacklinks(viewId).then((rows) => {
      if (!alive) return;
      setBacklinks(rows);
      const m = new Map<string, View>();
      for (const r of rows) {
        if (!m.has(r.src_view_id)) m.set(r.src_view_id, r.src_view);
      }
      setBacklinkViews(m);
    });
    return () => {
      alive = false;
    };
  }, [viewId]);

  // 反链按来源分组：src_view_id → MentionRow[]
  const groupedBacklinks = useMemo(() => {
    const m = new Map<string, MentionRow[]>();
    for (const r of backlinks) {
      const arr = m.get(r.src_view_id) ?? [];
      arr.push(r);
      m.set(r.src_view_id, arr);
    }
    return m;
  }, [backlinks]);

  return (
    <>
      {/* 反链面板：底部固定，可收起；专注模式下连同外壳一起藏起 */}
      {!hidden && backlinks.length > 0 && (
        <div className="shrink-0 border-t border-neutral-200 bg-neutral-50/60">
          <button
            type="button"
            onClick={() => setBacklinksOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100"
          >
            <Link2 className="h-3 w-3" />
            {t("backlinks.title", { n: groupedBacklinks.size })}
            {backlinksOpen ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
          </button>
          {backlinksOpen && (
            <div className="max-h-[160px] overflow-y-auto px-4 pb-2">
              {Array.from(groupedBacklinks.entries()).map(([srcId, rows]) => {
                const srcView = backlinkViews.get(srcId);
                const name = srcView?.name ?? srcId;
                return (
                  <div key={srcId} className="mb-1.5 last:mb-0">
                    <div className="flex items-center gap-1 text-[11px] text-neutral-500">
                      <button
                        type="button"
                        className="font-medium text-brand-600 hover:underline"
                        onClick={() => useWorkspaceStore.getState().openView(srcId)}
                        title={t("backlinks.openSource")}
                      >
                        {name}
                      </button>
                      <span className="text-neutral-400">· {rows.length}</span>
                    </div>
                    <ul className="ml-2 mt-0.5 space-y-0.5">
                      {rows.slice(0, 3).map((r) => (
                        <li
                          key={r.id}
                          role="button"
                          aria-label={t("backlinks.contextLabel")}
                          className="cursor-pointer rounded px-1.5 py-0.5 text-[12px] text-neutral-600 hover:bg-neutral-100"
                          onClick={() => useWorkspaceStore.getState().openView(srcId)}
                          title={t("backlinks.contextLabel")}
                        >
                          {r.context_text ?? ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
