import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { CellValue, DatabaseField } from "@/types/database";
import { defaultOperand, opsForType, type FilterMode, type FilterOp, type FilterSpec } from "@/lib/database-query";
import { parseFieldOptions } from "@/lib/database-values";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** 筛选值输入（按字段类型） */
function FilterValueInput(props: { field: DatabaseField; value: CellValue; onChange: (v: CellValue) => void }) {
  const { field, value, onChange } = props;
  const opts = parseFieldOptions(field.options);
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");

  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    const options = opts.kind === "select" ? opts.options : [];
    return (
      <select
        className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-[12px] outline-none focus:border-brand-500"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (field.field_type === "number") {
    return (
      <input
        type="number"
        step="any"
        className="h-7 w-28 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : null);
        }}
      />
    );
  }
  if (field.field_type === "date" || field.field_type === "created_at" || field.field_type === "last_edited_at") {
    return (
      <input
        type="date"
        className="h-7 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
        value={typeof value === "string" ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <input
      className="h-7 w-36 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value || null);
      }}
    />
  );
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

  const addFilter = () => {
    const field = visibleFields[0];
    if (!field) return;
    const op = opsForType(field.field_type)[0];
    onChange(
      [...filters, { id: "flt_" + crypto.randomUUID().slice(0, 8), field_id: field.id, op, value: defaultOperand(field) }],
      mode,
    );
  };

  const update = (id: string, patch: Partial<FilterSpec>) => {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)), mode);
  };

  const remove = (id: string) => {
    onChange(filters.filter((f) => f.id !== id), mode);
  };

  const fieldById = (id: string) => visibleFields.find((f) => f.id === id);

  return (
    <div data-testid="filter-bar" className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100/60 px-4 py-2">
      <div className="flex items-center gap-1 text-[12px]">
        <button
          className={cn("rounded px-1.5 py-0.5 font-medium", mode === "and" ? "bg-brand-500 text-white" : "text-neutral-500 hover:bg-neutral-200")}
          onClick={() => onChange(filters, "and")}
        >
          AND
        </button>
        <button
          className={cn("rounded px-1.5 py-0.5 font-medium", mode === "or" ? "bg-brand-500 text-white" : "text-neutral-500 hover:bg-neutral-200")}
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
              <FilterValueInput field={field} value={f.value} onChange={(v) => update(f.id, { value: v })} />
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
      <button className="ml-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200" onClick={onClose}>
        <X className="h-4 w-4" />
      </button>
      {filters.length > 0 && (
        <span className="text-[11px] text-neutral-400">
          {t("filter.active", { count: String(filters.length) })}
        </span>
      )}
    </div>
  );
}