import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import type { DatabaseField } from "@/types/database";
import type { SortSpec } from "@/lib/database-query";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** 排序条：多字段排序（表头单击也可加排序/切方向/取消） */
export function SortBar(props: {
  fields: DatabaseField[];
  sorts: SortSpec[];
  onChange: (sorts: SortSpec[]) => void;
  onClose: () => void;
}) {
  const { fields, sorts, onChange, onClose } = props;
  const visibleFields = fields.filter((f) => f.is_hidden === 0);

  const addSort = () => {
    const field = visibleFields.find((f) => !sorts.some((s) => s.field_id === f.id));
    if (!field) return;
    onChange([...sorts, { field_id: field.id, dir: "asc" }]);
  };

  const update = (fieldId: string, patch: Partial<SortSpec>) => {
    onChange(sorts.map((s) => (s.field_id === fieldId ? { ...s, ...patch } : s)));
  };

  const remove = (fieldId: string) => {
    onChange(sorts.filter((s) => s.field_id !== fieldId));
  };

  return (
    <div
      data-testid="sort-bar"
      className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100/60 px-4 py-2"
    >
      <span className="text-[12px] font-medium text-neutral-500">{t("sort.title")}</span>

      {sorts.map((s, index) => {
        // 已用于其它排序键的字段不再出现在选项里：同一字段重复排序没有意义
        const candidates = visibleFields.filter((f) => f.id === s.field_id || !sorts.some((o) => o.field_id === f.id));
        return (
          <div
            key={s.field_id}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2 py-1"
          >
            <span className="text-[11px] text-neutral-400">{index + 1}</span>
            <select
              className="h-7 max-w-36 rounded border-none bg-transparent text-[12px] outline-none"
              value={s.field_id}
              onChange={(e) => update(s.field_id, { field_id: e.target.value })}
            >
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-neutral-700 hover:bg-neutral-200"
              title={s.dir === "asc" ? t("sort.dir.asc") : t("sort.dir.desc")}
              onClick={() => update(s.field_id, { dir: s.dir === "asc" ? "desc" : "asc" })}
            >
              {s.dir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
              {s.dir === "asc" ? t("sort.dir.asc") : t("sort.dir.desc")}
            </button>
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500"
              onClick={() => remove(s.field_id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={addSort} disabled={sorts.length >= visibleFields.length}>
        <Plus className="h-3.5 w-3.5" />
        {t("sort.add")}
      </Button>
      <button
        className="ml-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
      {sorts.length > 0 && (
        <span className="text-[11px] text-neutral-400">{t("sort.active", { count: String(sorts.length) })}</span>
      )}
    </div>
  );
}
