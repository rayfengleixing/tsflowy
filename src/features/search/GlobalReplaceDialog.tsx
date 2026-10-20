// 跨页全局替换弹窗（入口在搜索结果页标题栏）。
// 先「预览」再「全部替换」：预览走的是同一条改写逻辑（dryRun），所以列表里的处数就是执行后的处数；
// 执行不可整批撤销（逐页各自落库），落库时 Rust 侧会按节流策略存历史快照，弹窗的确认框负责说清改几页几处。
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import { runGlobalReplace, type GlobalReplaceReport } from "./global-replace";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时带入的查询词（搜索结果页当前的关键词） */
  initialQuery: string;
}

export function GlobalReplaceDialog({ open, onOpenChange, initialQuery }: Props) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const openView = useWorkspaceStore((s) => s.openView);
  const setRoute = useWorkspaceStore((s) => s.setRoute);
  const [search, setSearch] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [report, setReport] = useState<GlobalReplaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 取消标记放 ref：执行循环是命令式的，不能等 state 重渲染才看得见
  const cancelRef = useRef(false);

  // 每次打开都退回「带过来那行查询词」的初始态，别拿上一次的预览结果糊弄这一次
  useEffect(() => {
    if (!open) return;
    setSearch(initialQuery);
    setReport(null);
    setProgress("");
    setBusy(false);
    setConfirmOpen(false);
    cancelRef.current = false;
  }, [open, initialQuery]);

  const run = async (dryRun: boolean) => {
    if (!workspaceId || !search) return;
    setBusy(true);
    setProgress(t("search.replace.progress", { done: "0", total: "0" }));
    cancelRef.current = false;
    try {
      const next = await runGlobalReplace({
        workspaceId,
        search,
        replace: replacement,
        options: { caseSensitive, wholeWord },
        dryRun,
        onProgress: (done, total) =>
          setProgress(t("search.replace.progress", { done: String(done), total: String(total) })),
        isCancelled: () => cancelRef.current,
      });
      setReport(next);
      if (!dryRun) {
        toast.success(t("search.replace.done", { pages: String(next.pages.length), hits: String(next.replaced) }));
      }
    } catch (e) {
      logger.error("global replace failed", e);
      toast.error(t("search.replace.failed", { message: String(e) }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const hints =
    report === null
      ? ""
      : [
          report.crossFormat > 0 ? t("search.replace.crossHint", { count: String(report.crossFormat) }) : "",
          report.protectedTitle > 0 ? t("search.replace.titleHint", { count: String(report.protectedTitle) }) : "",
          report.stopped ? t("search.replace.stopped") : "",
        ]
          .filter(Boolean)
          .join(" ");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[560px]">
          <DialogHeader>
            <DialogTitle>{t("search.replace.title")}</DialogTitle>
            <DialogDescription>{t("search.replace.desc")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Input
              aria-label={t("search.replace.find")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("search.replace.find")}
            />
            <Input
              aria-label={t("search.replace.with")}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={t("search.replace.with")}
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-neutral-500">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-600"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              {t("search.replace.caseSensitive")}
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-neutral-500">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-600"
                checked={wholeWord}
                onChange={(e) => setWholeWord(e.target.checked)}
              />
              {t("search.replace.wholeWord")}
            </label>
          </div>

          <div className="mt-2 min-h-24 max-h-72 overflow-y-auto rounded-md border border-neutral-100 dark:border-neutral-800">
            {report === null ? (
              <p className="px-3 py-6 text-center text-[12px] text-neutral-400">{t("search.replace.hint")}</p>
            ) : report.pages.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-neutral-400">
                {t("search.replace.none", { query: search })}
              </p>
            ) : (
              <ul className="flex flex-col">
                {report.pages.map((page) => (
                  <li key={page.viewId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-200/60"
                      title={t("search.replace.openPage")}
                      onClick={() => {
                        openView(page.viewId);
                        setRoute("workspace");
                        onOpenChange(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800 dark:text-neutral-100">
                        {page.title}
                      </span>
                      <span className="shrink-0 text-[12px] tabular-nums text-neutral-500">
                        {t("search.replace.hits", { count: String(page.replaced) })}
                      </span>
                      {page.crossFormat > 0 && (
                        <span className="shrink-0 text-[11px] text-amber-600">
                          {t("search.replace.cross", { count: String(page.crossFormat) })}
                        </span>
                      )}
                      {page.protectedTitle > 0 && (
                        <span className="shrink-0 text-[11px] text-neutral-400">
                          {t("search.replace.titleHit", { count: String(page.protectedTitle) })}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {hints && <p className="mt-2 text-[11px] text-neutral-500">{hints}</p>}

          <DialogFooter>
            {busy ? (
              <Button variant="ghost" onClick={() => (cancelRef.current = true)} data-testid="replace-cancel">
                {progress || t("search.replace.cancel")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" disabled={!search} onClick={() => void run(true)} data-testid="replace-preview">
                  {t("search.replace.preview")}
                </Button>
                <Button disabled={!search} onClick={() => setConfirmOpen(true)} data-testid="replace-apply">
                  {t("search.replace.apply")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        danger={false}
        title={t("search.replace.apply")}
        description={t("search.replace.confirm", { from: search, to: replacement })}
        confirmLabel={t("search.replace.applyConfirm")}
        onConfirm={() => void run(false)}
      />
    </>
  );
}
