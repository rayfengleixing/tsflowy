import { useEffect, useRef, useState } from "react";
import { GitCompareArrows, History, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { contentToDiffText, diffLines, visibleFlags, type DiffLine, type DiffResult } from "@/lib/doc-diff";
import { documentApi, type SnapshotRow } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import type { View } from "@/types/models";

interface HistoryDialogProps {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CompareMode = "prev" | "current";

interface CompareState {
  id: number;
  mode: CompareMode;
  loading: boolean;
  error: string | null;
  result: DiffResult | null;
  /** 列表里最早的一份没有上一版可比 */
  noPrev: boolean;
  /** 对比左右两侧各是哪一份；null 表示「当前已保存内容」（它没有快照时间） */
  beforeAt: number | null;
  afterAt: number | null;
}

/** 面板上写清左右两侧各是哪一份：null 表示「当前已保存内容」，它没有快照时间 */
function sideLabel(ms: number | null): string {
  return ms === null ? t("history.currentContent") : formatTime(ms);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `${t("history.today")} ${time}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${time}`;
}

/** 渲染行：diff 行，或被折叠掉的「省略 n 行」分隔 */
type DiffRow = { key: string; line: DiffLine } | { key: string; gap: number };

/** 未改动的长段压成一条分隔：翻历史时看的是改动，不是把整篇再抄一遍 */
function collapseUnchanged(lines: DiffLine[]): DiffRow[] {
  const flags = visibleFlags(lines, 2);
  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, i) => {
    if (!flags[i]) {
      hidden++;
      return;
    }
    if (hidden > 0) {
      rows.push({ key: `gap-${i}`, gap: hidden });
      hidden = 0;
    }
    rows.push({ key: `line-${i}`, line });
  });
  if (hidden > 0) rows.push({ key: "gap-end", gap: hidden });
  return rows;
}

function DiffView({ result }: { result: DiffResult }) {
  if (result.added === 0 && result.removed === 0) {
    return <p className="py-3 text-center text-[11px] text-neutral-400">{t("history.diffUnchanged")}</p>;
  }
  return (
    <div className="mt-1">
      <div className="mb-1 flex flex-wrap items-center gap-3 text-[11px]">
        <span className="text-emerald-700">{t("history.diffAdded", { n: result.added })}</span>
        <span className="text-red-600">{t("history.diffRemoved", { n: result.removed })}</span>
        {result.capped && <span className="text-amber-600">{t("history.diffCapped")}</span>}
      </div>
      <div className="max-h-[42vh] overflow-y-auto rounded-md border border-neutral-200 font-mono text-[11px] leading-relaxed">
        {collapseUnchanged(result.lines).map((row) =>
          "gap" in row ? (
            <div key={row.key} className="bg-neutral-50 px-2 py-0.5 text-center text-[10px] text-neutral-400">
              {t("history.diffGap", { n: row.gap })}
            </div>
          ) : (
            <div
              key={row.key}
              className={
                row.line.kind === "add"
                  ? "break-words bg-emerald-50 px-2 whitespace-pre-wrap text-emerald-800"
                  : row.line.kind === "del"
                    ? "break-words bg-red-50 px-2 whitespace-pre-wrap text-red-700"
                    : "break-words px-2 whitespace-pre-wrap text-neutral-400"
              }
            >
              {row.line.text || " "}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** 历史版本：快照列表（新→旧）+ 逐版本内容对比 + 一键恢复。间隔与份数见设置 → 数据保留策略。 */
export function HistoryDialog({ view, open, onOpenChange }: HistoryDialogProps) {
  const reload = useWorkspaceStore((s) => s.reload);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [compare, setCompare] = useState<CompareState | null>(null);
  // 连点不同版本时，先发后至的回答要丢掉，否则看到的是另一版的 diff
  const compareSeq = useRef(0);

  useEffect(() => {
    if (!open || !view) return;
    setLoading(true);
    setCompare(null);
    documentApi
      .listSnapshots(view.id)
      .then(setSnapshots)
      .catch((e: unknown) => {
        logger.error("list snapshots failed", e);
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
      logger.error("restore snapshot failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setRestoring(null);
    }
  };

  /**
   * 对比的两侧都是整份 doc JSON，各自转成 Markdown 再逐行比（见 lib/doc-diff）。
   * prev：上一版 → 这一版（这一版改了什么）；current：这一版 → 当前已保存内容（这版之后又改了什么）。
   */
  const loadCompare = async (index: number, mode: CompareMode) => {
    const snap = snapshots[index];
    // 列表新→旧，下一项就是上一版；最早的一份没有上一版可比
    const older = index + 1 < snapshots.length ? snapshots[index + 1] : undefined;
    const beforeId = mode === "prev" ? older?.id : snap.id;
    // 左右两侧到底是哪两份，面板要写出来（时间相同的多份也靠它区分）
    const beforeAt = mode === "prev" ? (older?.created_at ?? snap.created_at) : snap.created_at;
    const afterAt = mode === "prev" ? snap.created_at : null;
    if (beforeId === undefined) {
      setCompare({
        id: snap.id,
        mode,
        loading: false,
        error: null,
        result: null,
        noPrev: true,
        beforeAt,
        afterAt,
      });
      return;
    }
    const seq = ++compareSeq.current;
    setCompare({
      id: snap.id,
      mode,
      loading: true,
      error: null,
      result: null,
      noPrev: false,
      beforeAt,
      afterAt,
    });
    try {
      const [beforeRaw, afterRaw] = await Promise.all([
        documentApi.snapshotContent(beforeId),
        mode === "prev" ? documentApi.snapshotContent(snap.id) : documentApi.get(view.id),
      ]);
      if (seq !== compareSeq.current) return;
      setCompare({
        id: snap.id,
        mode,
        loading: false,
        error: null,
        result: diffLines(contentToDiffText(beforeRaw), contentToDiffText(afterRaw)),
        noPrev: false,
        beforeAt,
        afterAt,
      });
    } catch (e) {
      if (seq !== compareSeq.current) return;
      logger.error("compare snapshot failed", e);
      setCompare({
        id: snap.id,
        mode,
        loading: false,
        error: String(e),
        result: null,
        noPrev: false,
        beforeAt,
        afterAt,
      });
    }
  };

  const toggleCompare = (index: number) => {
    const snap = snapshots[index];
    if (compare?.id === snap.id) {
      compareSeq.current++;
      setCompare(null);
      return;
    }
    void loadCompare(index, compare?.mode ?? "prev");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={compare ? "w-[min(92vw,760px)]" : "w-[420px]"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("history.title")}
          </DialogTitle>
          <DialogDescription className="truncate">{view.name}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading && <div className="py-6 text-center text-xs text-neutral-400">{t("history.loading")}</div>}
          {!loading && snapshots.length === 0 && (
            <div className="py-6 text-center text-xs text-neutral-400">{t("history.empty")}</div>
          )}
          {snapshots.map((snap, index) => (
            <div key={snap.id} className="border-b border-neutral-100 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] text-neutral-700">{formatTime(snap.created_at)}</div>
                  <div className="text-[11px] text-neutral-400">
                    {snap.reason === "pre_restore" ? t("history.preRestore") : t("history.auto")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => toggleCompare(index)}>
                    <GitCompareArrows className="mr-1 h-3 w-3" />
                    {compare?.id === snap.id ? t("history.compareHide") : t("history.compare")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restoring !== null}
                    onClick={() => void restore(snap.id)}
                  >
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
              </div>
              {compare?.id === snap.id && (
                <div className="mt-2 rounded-md bg-neutral-50 p-2 dark:bg-neutral-800/40">
                  <div className="flex flex-wrap items-center gap-1 text-[11px]">
                    {(["prev", "current"] as const).map((mode) => (
                      <Button
                        key={mode}
                        variant={compare.mode === mode ? "secondary" : "ghost"}
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void loadCompare(index, mode)}
                      >
                        {mode === "prev" ? t("history.compareWithPrev") : t("history.compareWithCurrent")}
                      </Button>
                    ))}
                  </div>
                  {compare.loading && (
                    <p className="py-3 text-center text-[11px] text-neutral-400">{t("history.compareLoading")}</p>
                  )}
                  {compare.error && (
                    <p className="py-2 text-[11px] text-red-600">
                      {t("history.compareFailed", { message: compare.error })}
                    </p>
                  )}
                  {compare.noPrev && !compare.loading && (
                    <p className="py-2 text-[11px] text-neutral-500">{t("history.compareNoPrev")}</p>
                  )}
                  {!compare.loading && !compare.error && !compare.noPrev && compare.result && (
                    <>
                      <div className="mt-1 text-[11px] text-neutral-500">
                        {sideLabel(compare.beforeAt)} → {sideLabel(compare.afterAt)}
                      </div>
                      <DiffView result={compare.result} />
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-[11px] text-neutral-400">{t("history.hint")}</p>
      </DialogContent>
    </Dialog>
  );
}
