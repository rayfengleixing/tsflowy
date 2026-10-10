import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import type { AiActionRecord } from "@/stores/ai";

/**
 * AI 建议的文档改动对比。
 * 落地前给用户在「原文 / 改为」之间做一次肉眼确认，避免模型整段替换掉不想动的内容。
 * 插入与追加类指令没有原文，右侧只展示新增内容。
 */
export function EditDiffDialog({
  record,
  open,
  onOpenChange,
  onApply,
}: {
  record: AiActionRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply?: () => void;
}) {
  const pending = record?.state === "pending";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("ai.diffTitle")}</DialogTitle>
          {record?.summary && <p className="text-[12px] text-neutral-500">{record.summary}</p>}
          {/* 跨页面动作要说清改的是哪一页，否则用户会以为改的是当前页 */}
          {record?.pageName && (
            <p className="text-[12px] text-neutral-500">{t("ai.actionPage", { name: record.pageName })}</p>
          )}
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-medium text-neutral-500">{t("ai.diffBefore")}</p>
            <pre className="max-h-56 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/50 dark:text-neutral-300">
              {record?.before.trim() ? record.before : t("ai.diffNoBefore")}
            </pre>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-neutral-500">{t("ai.diffAfter")}</p>
            <pre className="max-h-56 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/50 dark:text-neutral-300">
              {record?.content ?? ""}
            </pre>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {pending && onApply && (
            <Button
              onClick={() => {
                onApply();
                onOpenChange(false);
              }}
            >
              {t("ai.applyEdit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
