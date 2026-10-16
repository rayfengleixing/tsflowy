import { useCallback, useMemo, useState } from "react";
import { CornerUpLeft } from "lucide-react";
import type { DatabaseRow } from "@/types/database";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MAX_HIERARCHY_LEVEL, parentCandidates } from "@/lib/database-hierarchy";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 选父行：候选由 parentCandidates 过滤掉自己、后代与会超深的行，所以列表里点到的都一定合法 */
export function RowParentDialog({
  open,
  onOpenChange,
  rows,
  row,
  labelOf,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 本表全部行（未经筛选的行集）：候选要看到全量，否则挂在被筛掉的父行下会选不到 */
  rows: DatabaseRow[];
  row: DatabaseRow | null;
  /** 行的显示标题（主列文本），空值由调用方兜底 */
  labelOf: (rowId: string) => string;
  onPick: (parentId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => (row ? parentCandidates(rows, row.id) : []), [rows, row]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? candidates.filter((r) => labelOf(r.id).toLowerCase().includes(needle)) : candidates;

  const pick = useCallback(
    (parentId: string | null) => {
      setQuery("");
      onPick(parentId);
    },
    [onPick],
  );

  return (
    <Dialog
      open={open && !!row}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("row.parentDialogTitle")}</DialogTitle>
          <DialogDescription>{t("row.parentDialogDesc", { max: String(MAX_HIERARCHY_LEVEL) })}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          placeholder={t("sidebar.search")}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="row-parent-search"
        />
        <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 border-b border-neutral-200 px-3 py-2 text-left text-[13px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800",
              row?.parent_id == null && "text-neutral-400 dark:text-neutral-500",
            )}
            onClick={() => pick(null)}
            data-testid="row-parent-none"
          >
            <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            {t("row.parentNone")}
          </button>
          {shown.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-500">{t("row.parentEmpty")}</div>
          ) : (
            shown.map((r) => (
              <button
                key={r.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-neutral-100 dark:hover:bg-neutral-800",
                  r.id === row?.parent_id && "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
                )}
                onClick={() => pick(r.id)}
                data-testid={"row-parent-" + r.id}
              >
                <span className="tabular-nums w-5 shrink-0 text-center text-[11px] text-neutral-400">
                  {r.position + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{labelOf(r.id)}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
