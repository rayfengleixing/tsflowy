import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { opsForType, type FilterOp } from "@/lib/database-query";
import {
  COND_TONES,
  COND_TONE_DOT,
  MAX_COND_RULES,
  newCondRule,
  type CondFormatRule,
  type CondScope,
} from "@/lib/database-cond-format";
import { useRelationDbs } from "./use-database-data";
import { FilterValueInput, NO_OPERAND_OPS } from "./FilterBar";
import type { DatabaseField } from "@/types/database";

/**
 * 条件格式规则表：一条规则 = 「某列（或整行）在某条件下上某色」。
 * 比较符与操作数沿用筛选那套（同一字段类型同一批运算符），编辑体验不用重新学一遍。
 */
export function CondFormatDialog({
  open,
  onOpenChange,
  fields,
  rules,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: DatabaseField[];
  rules: CondFormatRule[];
  onChange: (rules: CondFormatRule[]) => void;
}) {
  const getDb = useRelationDbs(fields);
  const candidates = useMemo(
    () => fields.filter((f) => f.is_hidden === 0 || rules.some((r) => r.field_id === f.id)),
    [fields, rules],
  );

  const patchRule = (id: string, patch: Partial<CondFormatRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addRule = () => {
    if (rules.length >= MAX_COND_RULES || candidates.length === 0) return;
    onChange([...rules, newCondRule("cdf_" + crypto.randomUUID().slice(0, 8), candidates[0])]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("cond.title")}</DialogTitle>
          <DialogDescription>{t("cond.desc")}</DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <div className="py-6 text-center text-sm text-neutral-500">{t("cond.noField")}</div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {rules.length === 0 && <p className="py-2 text-center text-[12px] text-neutral-500">{t("cond.empty")}</p>}
            {rules.map((rule) => (
              <CondRuleRow
                key={rule.id}
                rule={rule}
                fields={candidates}
                getDb={getDb}
                onPatch={(patch) => patchRule(rule.id, patch)}
                onRemove={() => onChange(rules.filter((r) => r.id !== rule.id))}
              />
            ))}
          </div>
        )}

        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[11px] text-neutral-400">
            {t("cond.orderHint")}
            {rules.length >= MAX_COND_RULES && <span className="ml-1 text-red-500">{t("cond.limit")}</span>}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={addRule}
              disabled={candidates.length === 0 || rules.length >= MAX_COND_RULES}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("cond.add")}
            </Button>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t("common.done")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CondRuleRow({
  rule,
  fields,
  getDb,
  onPatch,
  onRemove,
}: {
  rule: CondFormatRule;
  fields: DatabaseField[];
  getDb: ReturnType<typeof useRelationDbs>;
  onPatch: (patch: Partial<CondFormatRule>) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.id === rule.field_id);
  const scopeBtn = (s: CondScope) =>
    cn(
      "rounded px-1.5 py-0.5 text-[11px]",
      rule.scope === s ? "bg-brand-500 text-white" : "text-neutral-500 hover:bg-neutral-200",
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2 py-1.5">
      <div className="flex shrink-0 items-center gap-1 rounded bg-neutral-100 p-0.5">
        <button type="button" className={scopeBtn("cell")} onClick={() => onPatch({ scope: "cell" })}>
          {t("cond.scope.cell")}
        </button>
        <button type="button" className={scopeBtn("row")} onClick={() => onPatch({ scope: "row" })}>
          {t("cond.scope.row")}
        </button>
      </div>

      <select
        className="h-7 max-w-40 min-w-24 rounded border border-neutral-200 bg-white px-1.5 text-[12px] outline-none focus:border-brand-500"
        value={rule.field_id}
        onChange={(e) => {
          const nf = fields.find((f) => f.id === e.target.value);
          if (!nf) return;
          onPatch({ field_id: nf.id, op: opsForType(nf.field_type)[0], value: null });
        }}
      >
        {/* 字段被删后不在候选里，但仍要把当前值显示出来，否则选择器会跳到第一项 */}
        {!field && <option value={rule.field_id}>{t("cond.deletedField")}</option>}
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>

      <select
        className="h-7 rounded border border-neutral-200 bg-white px-1.5 text-[12px] outline-none focus:border-brand-500"
        value={rule.op}
        onChange={(e) => onPatch({ op: e.target.value as FilterOp })}
      >
        {opsForType(field?.field_type ?? "text").map((op) => (
          <option key={op} value={op}>
            {t(`filter.op.${op}` as never)}
          </option>
        ))}
      </select>

      {!NO_OPERAND_OPS.includes(rule.op) && field && (
        <div className="min-w-32 flex-1">
          <FilterValueInput field={field} value={rule.value} getDb={getDb} onChange={(v) => onPatch({ value: v })} />
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {COND_TONES.map((tone) => (
          <button
            key={tone}
            type="button"
            title={t("cond.tone")}
            onClick={() => onPatch({ tone })}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded border",
              rule.tone === tone ? "border-brand-500 bg-brand-50" : "border-neutral-200 hover:bg-neutral-100",
            )}
          >
            <span className={cn("h-3 w-3 rounded-full", COND_TONE_DOT[tone])} />
          </button>
        ))}
      </div>

      <button
        type="button"
        className="shrink-0 rounded p-1 text-neutral-400 hover:bg-red-100 hover:text-red-500"
        title={t("cond.remove")}
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
