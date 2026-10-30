import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OptionChip } from "./cell-display";
import { t, type MessageKey } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { parseFieldOptions, ratingMax } from "@/lib/database/database-values";
import {
  bulkEditable,
  bulkOpsFor,
  bulkTargetValue,
  bulkValueKind,
  buildBulkUpdates,
  emptyBulkDraft,
  type BulkDraft,
  type BulkOp,
  type BulkUpdate,
  type BulkValueKind,
} from "@/lib/database/database-bulk-edit";
import { cn } from "@/lib/utils";
import type { CellValue, DatabaseField, SelectOption } from "@/types/database";

// 只存键名：在模块顶层调 t() 会把文案钉在导入时的语言上，切英文后就不动了
const OP_LABEL: Record<BulkOp, MessageKey> = {
  set: "bulk.op.set",
  clear: "bulk.op.clear",
  add: "bulk.op.add",
  remove: "bulk.op.remove",
  toggle: "bulk.op.toggle",
};

/** 批量改值：勾选多行后一次改掉同一字段。值控件按字段类型换形态，语义都在 database-bulk-edit 里 */
export function BulkEditDialog({
  open,
  onOpenChange,
  fields,
  rowIds,
  readCell,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 表内全部字段，弹窗自己滤掉批量改不动的（只读列/附件/关联） */
  fields: DatabaseField[];
  /** 勾选的行 id */
  rowIds: string[];
  readCell: (rowId: string, fieldId: string) => CellValue | undefined;
  onApply: (updates: BulkUpdate[]) => Promise<void>;
}) {
  const editable = useMemo(() => fields.filter(bulkEditable), [fields]);
  // 项目没开 noUncheckedIndexedAccess，越界下标在类型上不是 undefined，判长度才写得清楚
  const [fieldId, setFieldId] = useState<string>(() => (editable.length > 0 ? editable[0].id : ""));
  const picked = editable.find((f) => f.id === fieldId);
  const field = picked ?? (editable.length > 0 ? editable[0] : null);
  const ops = field ? bulkOpsFor(field) : [];
  const [op, setOp] = useState<BulkOp>("set");
  const [draft, setDraft] = useState(emptyBulkDraft);
  const [busy, setBusy] = useState(false);

  // 换字段等于换一套操作与控件：留在上一个字段的操作上会算出莫名其妙的值
  useEffect(() => {
    const firstOp = field ? bulkOpsFor(field) : [];
    setOp(firstOp.length > 0 ? firstOp[0] : "set");
    setDraft(emptyBulkDraft());
  }, [field]);

  const kind = field ? bulkValueKind(field, op) : "none";
  const options = field ? selectOptionsOf(field) : [];
  const target = field ? bulkTargetValue(field, draft) : null;
  const needsValue = kind !== "none";
  // 多选的「一个选项都没勾」和文本框留空同义：这时应用没有意义
  const valueReady = !needsValue || (kind === "multi_option" ? draft.options.length > 0 : target !== null);

  const apply = async () => {
    if (!field || !valueReady) return;
    const updates = buildBulkUpdates({ field, op, target, rowIds, readCell });
    if (updates.length === 0) {
      toast.info(t("bulk.noChange"));
      return;
    }
    setBusy(true);
    try {
      await onApply(updates);
      toast.success(t("bulk.done", { count: String(updates.length) }));
      onOpenChange(false);
    } catch (e) {
      logger.error("bulk edit failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("bulk.title", { count: String(rowIds.length) })}</DialogTitle>
          <DialogDescription>{t("bulk.desc")}</DialogDescription>
        </DialogHeader>

        {!field ? (
          <div className="py-6 text-center text-sm text-neutral-500">{t("bulk.noEditableField")}</div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-[13px] text-neutral-600">
              <span className="w-14 shrink-0 text-neutral-500">{t("bulk.field")}</span>
              <select
                className="h-8 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-[13px] outline-none focus:border-brand-500"
                value={field.id}
                onChange={(e) => setFieldId(e.target.value)}
              >
                {editable.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[13px] text-neutral-500">{t("bulk.op")}</span>
              <div className="flex flex-wrap gap-1">
                {ops.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setOp(o)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[12px] hover:bg-neutral-100",
                      op === o ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-300 text-neutral-600",
                    )}
                  >
                    {t(OP_LABEL[o])}
                  </button>
                ))}
              </div>
            </div>

            {kind !== "none" && (
              <div className="flex items-start gap-2">
                <span className="w-14 shrink-0 pt-1.5 text-[13px] text-neutral-500">{t("bulk.value")}</span>
                <div className="min-w-0 flex-1">
                  <ValueControl field={field} kind={kind} options={options} draft={draft} setDraft={setDraft} />
                </div>
              </div>
            )}

            <div className="mt-1 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void apply()} disabled={!valueReady || busy || rowIds.length === 0}>
                {t("bulk.apply")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function selectOptionsOf(field: DatabaseField): SelectOption[] {
  const opts = parseFieldOptions(field.options);
  return opts.kind === "select" ? opts.options : [];
}

function ValueControl({
  field,
  kind,
  options,
  draft,
  setDraft,
}: {
  field: DatabaseField;
  kind: Exclude<BulkValueKind, "none">;
  options: SelectOption[];
  draft: BulkDraft;
  setDraft: (next: BulkDraft) => void;
}) {
  if (kind === "bool") {
    return (
      <div className="flex gap-1">
        {[true, false].map((b) => (
          <button
            key={String(b)}
            type="button"
            onClick={() => setDraft({ ...draft, bool: b })}
            className={cn(
              "rounded-md border px-2 py-1 text-[12px] hover:bg-neutral-100",
              draft.bool === b ? "border-brand-500 bg-brand-50 text-brand-700" : "border-neutral-300 text-neutral-600",
            )}
          >
            {t(b ? "bulk.check" : "bulk.uncheck")}
          </button>
        ))}
      </div>
    );
  }

  if (kind === "single_option" || kind === "multi_option") {
    if (options.length === 0) {
      return <div className="pt-1 text-[12px] text-neutral-500">{t("bulk.noOption")}</div>;
    }
    const multiple = kind === "multi_option";
    const toggleOne = (id: string) => {
      if (!multiple) {
        setDraft({ ...draft, option: id });
        return;
      }
      setDraft({
        ...draft,
        options: draft.options.includes(id) ? draft.options.filter((x) => x !== id) : [...draft.options, id],
      });
    };
    const isActive = (id: string) => (multiple ? draft.options.includes(id) : draft.option === id);
    return (
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-neutral-200 p-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => toggleOne(o.id)}
            className={cn(
              "flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-neutral-100",
              isActive(o.id) && "bg-brand-50",
            )}
          >
            <OptionChip option={o} />
            {!multiple && isActive(o.id) && <span className="ml-auto text-[11px] text-brand-600">✓</span>}
          </button>
        ))}
      </div>
    );
  }

  if (kind === "date") {
    const opts = parseFieldOptions(field.options);
    const includeTime = opts.kind === "date" && opts.include_time;
    return (
      <Input
        type={includeTime ? "datetime-local" : "date"}
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
      />
    );
  }

  if (kind === "number") {
    const min = field.field_type === "rating" ? 1 : field.field_type === "progress" ? 0 : undefined;
    const max =
      field.field_type === "rating"
        ? ratingMax(parseFieldOptions(field.options))
        : field.field_type === "progress"
          ? 100
          : undefined;
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="any"
          min={min}
          max={max}
          className="w-40"
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
        {field.field_type === "progress" && <span className="text-[12px] text-neutral-400">0–100</span>}
        {field.field_type === "rating" && max !== undefined && (
          <span className="text-[12px] text-neutral-400">1–{max}</span>
        )}
      </div>
    );
  }

  return <Input value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />;
}
