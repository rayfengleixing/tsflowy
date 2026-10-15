import { useState, type ComponentType } from "react";
import { Check, Plus, Search, Trash2, X } from "lucide-react";
import type { CellValue, DatabaseField, FieldOptions, FieldType } from "@/types/database";
import {
  RELATIVE_DATE_PREFIX,
  defaultOperand,
  isRelativeDateOperand,
  makeRelativeOperand,
  opsForType,
  relativeDayCount,
  type FilterMode,
  type FilterOp,
  type FilterSpec,
  type RelativeDateKey,
} from "@/lib/database-query";
import { parseFieldOptions, ratingMax } from "@/lib/database-values";
import { relationRowLabel, relationTarget, searchRelationRows } from "@/lib/relation";
import { useRelationDbs } from "./use-database-data";
import { RelationChip } from "./cell-display";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const RELATIVE_PRESETS: RelativeDateKey[] = [
  "today",
  "yesterday",
  "tomorrow",
  "this_week",
  "last_week",
  "next_week",
  "this_month",
  "last_month",
  "next_month",
  "past_days",
  "next_days",
];

const SELECT_CLS =
  "h-7 rounded-md border border-neutral-300 bg-white px-2 text-[12px] outline-none focus:border-brand-500";

/** 操作数录入控件的公共入参：控件按字段类型分派（见 FILTER_OPERANDS） */
interface FilterOperandProps {
  field: DatabaseField;
  value: CellValue;
  options: FieldOptions;
  /** 文本/数字输入的草稿。留在分派层，切换字段类型时不会重置——与改造前一致 */
  draft: string;
  onDraft: (text: string) => void;
  getDb: ReturnType<typeof useRelationDbs>;
  onChange: (v: CellValue) => void;
}

/** 日期操作数：绝对日期（YYYY-MM-DD，旧值原样可用）或 "@rel:…" 相对区间 */
function DateOperandInput({ value, onChange }: FilterOperandProps) {
  const isRel = isRelativeDateOperand(value);
  const relKey = isRelativeDateOperand(value)
    ? (value.slice(RELATIVE_DATE_PREFIX.length).split(":")[0] as RelativeDateKey)
    : "today";
  const days = relativeDayCount(typeof value === "string" ? value : "") ?? 7;
  const needsCount = relKey === "past_days" || relKey === "next_days";
  const absText = typeof value === "string" && !value.startsWith(RELATIVE_DATE_PREFIX) ? value.slice(0, 10) : "";
  return (
    <>
      <select
        className={SELECT_CLS}
        value={isRel ? "rel" : "abs"}
        onChange={(e) => onChange(e.target.value === "rel" ? makeRelativeOperand("today") : null)}
      >
        <option value="abs">{t("filter.date.absolute")}</option>
        <option value="rel">{t("filter.date.relative")}</option>
      </select>
      {isRel && (
        <>
          <select
            className={SELECT_CLS}
            value={relKey}
            onChange={(e) => onChange(makeRelativeOperand(e.target.value as RelativeDateKey, days))}
          >
            {RELATIVE_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`filter.date.${p}`, p === "past_days" || p === "next_days" ? { n: days } : undefined)}
              </option>
            ))}
          </select>
          {needsCount && (
            <input
              type="number"
              min={1}
              max={3650}
              className="h-7 w-16 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
              value={days}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange(makeRelativeOperand(relKey, Number.isInteger(n) && n >= 1 ? Math.min(3650, n) : 7));
              }}
            />
          )}
        </>
      )}
      {!isRel && (
        <input
          type="date"
          className="h-7 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
          value={absText}
          onChange={(e) => onChange(e.target.value || null)}
        />
      )}
    </>
  );
}

/** relation 操作数：从目标库行里挑选（比较按行 id；旧裸文本值当作单 id 兼容） */
function RelationOperandInput({ field, value, getDb, onChange }: FilterOperandProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const targetId = relationTarget(field);
  const db = targetId ? getDb(targetId) : undefined;
  const ids = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string" && value !== ""
      ? [value]
      : [];
  const candidates = db ? searchRelationRows(db, query).slice(0, 50) : [];
  const labelOf = (id: string) => (db ? relationRowLabel(db, id) : null) ?? id;
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  return (
    <div className="relative flex max-w-[240px] flex-wrap items-center gap-1">
      {ids.map((id) => (
        <RelationChip key={id} label={labelOf(id)} compact onRemove={() => toggle(id)} />
      ))}
      <button
        type="button"
        className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-500 outline-none hover:border-brand-500"
        onClick={() => setOpen((o) => !o)}
      >
        {t("filter.relation.placeholder")}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 flex max-h-64 w-64 flex-col rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
          {!!targetId && (
            <div className="relative mb-1 shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                autoFocus
                className="h-7 w-full rounded-md border border-neutral-200 pl-7 pr-2 text-[13px] outline-none placeholder:text-neutral-400 focus:border-brand-500"
                placeholder={t("field.relationSearch")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
            {!targetId && <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.relationUnset")}</div>}
            {!!targetId && !db && <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("app.loading")}</div>}
            {db && candidates.length === 0 && (
              <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.relationEmpty")}</div>
            )}
            {candidates.map((row) => (
              <button
                key={row.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-neutral-200/60",
                  ids.includes(row.id) && "bg-brand-100",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(row.id)}
              >
                <span className="min-w-0 flex-1 truncate">{labelOf(row.id)}</span>
                {ids.includes(row.id) && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
              </button>
            ))}
          </div>
          {ids.length > 0 && (
            <button
              type="button"
              className="flex w-full shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange([])}
            >
              <X className="h-3.5 w-3.5" />
              {t("common.clearAll")}
            </button>
          )}
        </div>
      )}
      {open && <div className="fixed inset-0 z-20" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

/** 选择类：按选项列表下拉（筛选值恒为单个选项 id，与改造前一致） */
function SelectOperand({ options, value, onChange }: FilterOperandProps) {
  const items = options.kind === "select" ? options.options : [];
  return (
    <select
      className={SELECT_CLS}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">—</option>
      {items.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/** 数字族（number / currency / progress）：数值输入，草稿由分派层持有 */
function NumberOperand({ draft, onDraft, onChange }: FilterOperandProps) {
  return (
    <input
      type="number"
      step="any"
      className="h-7 w-28 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
      value={draft}
      onChange={(e) => {
        onDraft(e.target.value);
        // 清空输入框时 Number("") === 0，会把筛选条件变成"等于 0"
        if (e.target.value.trim() === "") {
          onChange(null);
          return;
        }
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? n : null);
      }}
    />
  );
}

/** 评分：按满星数给下拉 */
function RatingOperand({ options, value, onChange }: FilterOperandProps) {
  const max = ratingMax(options);
  return (
    <select
      className={SELECT_CLS}
      value={typeof value === "number" ? String(value) : ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      <option value="">—</option>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <option key={n} value={n}>
          {"★".repeat(n)}
        </option>
      ))}
    </select>
  );
}

/** 兜底：文本 / 链接 / 电话 / 邮箱，以及公式、汇总等只读计算列 */
function TextOperand({ draft, onDraft, onChange }: FilterOperandProps) {
  return (
    <input
      className="h-7 w-36 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
      value={draft}
      onChange={(e) => {
        onDraft(e.target.value);
        onChange(e.target.value || null);
      }}
    />
  );
}

/** 类型 → 操作数控件。新增字段类型只需在这里补一行，不必再加一层 if */
const FILTER_OPERANDS: Partial<Record<FieldType, ComponentType<FilterOperandProps>>> = {
  single_select: SelectOperand,
  multi_select: SelectOperand,
  number: NumberOperand,
  currency: NumberOperand,
  progress: NumberOperand,
  rating: RatingOperand,
  date: DateOperandInput,
  created_at: DateOperandInput,
  last_edited_at: DateOperandInput,
  relation: RelationOperandInput,
};

/** 筛选值输入（按字段类型） */
function FilterValueInput(props: Omit<FilterOperandProps, "options" | "draft" | "onDraft">) {
  const { field, value } = props;
  const options = parseFieldOptions(field.options);
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const Operand = FILTER_OPERANDS[field.field_type] ?? TextOperand;
  return <Operand {...props} options={options} draft={draft} onDraft={setDraft} />;
}

/** 筛选条（说明书 10-M4：多条件 AND/OR + 类型化比较符） */
export function FilterBar(props: {
  fields: DatabaseField[];
  filters: FilterSpec[];
  mode: FilterMode;
  onChange: (filters: FilterSpec[], mode: FilterMode) => void;
  onClose: () => void;
}) {
  const { fields, filters, mode, onChange, onClose } = props;
  const visibleFields = fields.filter((f) => f.is_hidden === 0);
  // relation 筛选操作数需要目标库行数据：与表格同一份缓存通道（内部只发一次 IPC）
  const getDb = useRelationDbs(visibleFields);

  const addFilter = () => {
    const field = visibleFields.length > 0 ? visibleFields[0] : undefined;
    if (!field) return;
    const op = opsForType(field.field_type)[0];
    onChange(
      [
        ...filters,
        { id: "flt_" + crypto.randomUUID().slice(0, 8), field_id: field.id, op, value: defaultOperand(field) },
      ],
      mode,
    );
  };

  const update = (id: string, patch: Partial<FilterSpec>) => {
    onChange(
      filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      mode,
    );
  };

  const remove = (id: string) => {
    onChange(
      filters.filter((f) => f.id !== id),
      mode,
    );
  };

  const fieldById = (id: string) => visibleFields.find((f) => f.id === id);

  return (
    <div
      data-testid="filter-bar"
      className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100/60 px-4 py-2"
    >
      <div className="flex items-center gap-1 text-[12px]">
        <button
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            mode === "and" ? "bg-brand-500 text-white" : "text-neutral-500 hover:bg-neutral-200",
          )}
          onClick={() => onChange(filters, "and")}
        >
          AND
        </button>
        <button
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            mode === "or" ? "bg-brand-500 text-white" : "text-neutral-500 hover:bg-neutral-200",
          )}
          onClick={() => onChange(filters, "or")}
        >
          OR
        </button>
      </div>

      {filters.map((f) => {
        const field = fieldById(f.field_id);
        if (!field) return null;
        return (
          <div key={f.id} className="flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2 py-1">
            <select
              className="h-7 max-w-36 rounded border-none bg-transparent text-[12px] outline-none"
              value={f.field_id}
              onChange={(e) => {
                const nf = fieldById(e.target.value);
                if (!nf) return;
                const op = opsForType(nf.field_type)[0];
                update(f.id, { field_id: e.target.value, op, value: defaultOperand(nf) });
              }}
            >
              {visibleFields.map((vf) => (
                <option key={vf.id} value={vf.id}>
                  {vf.name}
                </option>
              ))}
            </select>
            <select
              className="h-7 rounded border border-neutral-200 bg-white px-1.5 text-[12px] outline-none focus:border-brand-500"
              value={f.op}
              onChange={(e) => update(f.id, { op: e.target.value as FilterOp })}
            >
              {opsForType(field.field_type).map((op) => (
                <option key={op} value={op}>
                  {t(`filter.op.${op}` as never)}
                </option>
              ))}
            </select>
            {!["checked", "unchecked", "is_empty", "is_not_empty"].includes(f.op) && (
              <FilterValueInput
                field={field}
                value={f.value}
                getDb={getDb}
                onChange={(v) => update(f.id, { value: v })}
              />
            )}
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500"
              onClick={() => remove(f.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={addFilter} disabled={visibleFields.length === 0}>
        <Plus className="h-3.5 w-3.5" />
        {t("filter.add")}
      </Button>
      <button
        className="ml-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
      {filters.length > 0 && (
        <span className="text-[11px] text-neutral-400">{t("filter.active", { count: String(filters.length) })}</span>
      )}
    </div>
  );
}
