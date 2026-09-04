import { useEffect, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import type { ViewNode } from "@/types/models";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { viewIcon } from "@/components/view-icon";

/**
 * SubPagePicker（B-2）：在 slash 菜单 / 命令面板「插入子页面引用」时弹出。
 *
 * 交互：
 * - 过滤输入框：输入视图名 → 下方列表过滤
 * - 点击项 → 回调 onPick(viewId, name)
 * - ESC / 取消按钮 → onClose()
 *
 * 挂载方式：使用 document.body 容器（Dialog 形式），由 slash menu / toolbar 触发 open。
 */
export function SubPagePicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (viewId: string, name: string) => void;
}) {
  const tree = useWorkspaceStore((s) => s.tree);
  const currentViewId = useWorkspaceStore((s) => s.currentViewId);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  if (!open) return null;

  const kw = q.trim().toLowerCase();
  let rows: ViewNode[] = tree.filter(
    (v) => v.id !== currentViewId && (!kw || v.name.toLowerCase().includes(kw)),
  );
  rows = rows.slice(0, 30);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[520px] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-neutral-800">{t("subPage.pickTitle")}</h3>
        </div>
        <div className="p-3">
          <input
            autoFocus
            className="h-9 w-full rounded-md border border-neutral-300 px-2 text-sm outline-none focus:border-brand-500"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("subPage.search")}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="max-h-[42vh] min-h-[220px] overflow-y-auto px-2 pb-2">
          {rows.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-neutral-400">{t("search.noResults", { query: q })}</div>
          ) : (
            rows.map((v) => (
              <button
                key={v.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-neutral-100"
                onClick={() => onPick(v.id, v.name)}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(v)}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-700">{v.name || t("common.untitled")}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 px-3 py-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
