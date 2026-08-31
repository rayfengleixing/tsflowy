import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DatabaseField, FieldOptions, SelectOption } from "@/types/database";
import { newSelectOption, parseFieldOptions } from "@/lib/database-values";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OptionDot } from "./editors";
import { t } from "@/lib/i18n";

const SELECT_COLORS = ["blue", "green", "orange", "purple", "red", "yellow", "gray"];

/** 字段 options 编辑器（说明书 10-M4：单选选项管理/数字格式/日期格式） */
export function FieldOptionsEditor(props: {
  field: DatabaseField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (options: FieldOptions) => void;
}) {
  const { field, open, onOpenChange, onSave } = props;
  const initial = parseFieldOptions(field.options);
  const [options, setOptions] = useState<FieldOptions>(initial);
  const [optionName, setOptionName] = useState("");

  // 每次打开时重置
  const handleOpenChange = (next: boolean) => {
    if (next) setOptions(parseFieldOptions(field.options));
    onOpenChange(next);
  };

  const save = () => {
    onSave(options);
    onOpenChange(false);
  };

  const addOption = () => {
    const name = optionName.trim();
    if (!name) return;
    if (options.kind !== "select") return;
    setOptions({ ...options, options: [...options.options, newSelectOption(name)] });
    setOptionName("");
  };

  const updateOption = (id: string, patch: Partial<SelectOption>) => {
    if (options.kind !== "select") return;
    setOptions({ ...options, options: options.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  };

  const removeOption = (id: string) => {
    if (options.kind !== "select") return;
    setOptions({ ...options, options: options.options.filter((o) => o.id !== id) });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("field.optionsTitle", { name: field.name })}</DialogTitle>
        </DialogHeader>

        {field.field_type === "single_select" || field.field_type === "multi_select" ? (
          <div className="flex flex-col gap-2">
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {options.kind === "select" && options.options.length === 0 && (
                <p className="py-4 text-center text-[13px] text-neutral-400">{t("field.noOptions")}</p>
              )}
              {options.kind === "select" &&
                options.options.map((o) => (
                  <div key={o.id} className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center">
                      <OptionDot option={o} />
                    </span>
                    <input
                      className="h-7 flex-1 rounded border border-transparent bg-transparent px-2 text-[13px] outline-none hover:border-neutral-300 focus:border-brand-500"
                      value={o.name}
                      onChange={(e) => updateOption(o.id, { name: e.target.value })}
                    />
                    <div className="flex gap-0.5">
                      {SELECT_COLORS.map((c) => (
                        <button
                          key={c}
                          className={"h-3.5 w-3.5 rounded-full " + (o.color === c ? "ring-2 ring-brand-500" : "")}
                          style={{ background: { blue: "#00B5FF", green: "#4CAF50", orange: "#FFB020", purple: "#9747FF", red: "#FF5C5C", yellow: "#FFD700", gray: "#B5BBD3" }[c] }}
                          onClick={() => updateOption(o.id, { color: c })}
                        />
                      ))}
                    </div>
                    <button
                      className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500"
                      onClick={() => removeOption(o.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
            </div>
            <div className="flex gap-2">
              <input
                className="h-8 flex-1 rounded-md border border-neutral-300 px-2 text-[13px] outline-none focus:border-brand-500"
                placeholder={t("field.newOption")}
                value={optionName}
                onChange={(e) => setOptionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addOption();
                }}
              />
              <Button variant="outline" size="sm" onClick={addOption}>
                <Plus className="h-3.5 w-3.5" />
                {t("common.add")}
              </Button>
            </div>
          </div>
        ) : field.field_type === "number" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
              {t("field.numberFormat")}
              <select
                className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-[13px] outline-none focus:border-brand-500"
                value={options.kind === "number" ? options.format : "decimal"}
                onChange={(e) =>
                  setOptions({ ...(options.kind === "number" ? options : { kind: "number", format: "decimal", precision: 2, currency: "CNY" }), format: e.target.value as never })
                }
              >
                <option value="integer">{t("field.numInteger")}</option>
                <option value="decimal">{t("field.numDecimal")}</option>
                <option value="percent">{t("field.numPercent")}</option>
                <option value="currency">{t("field.numCurrency")}</option>
              </select>
            </label>
            {options.kind === "number" && options.format === "currency" && (
              <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
                {t("field.currency")}
                <input
                  className="h-8 rounded-md border border-neutral-300 px-2 text-[13px] outline-none focus:border-brand-500"
                  value={options.currency}
                  onChange={(e) => setOptions({ ...options, currency: e.target.value.toUpperCase() })}
                />
              </label>
            )}
            {options.kind === "number" && options.format !== "integer" && (
              <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
                {t("field.precision")}
                <select
                  className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-[13px] outline-none focus:border-brand-500"
                  value={options.precision}
                  onChange={(e) => setOptions({ ...options, precision: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3, 4].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : field.field_type === "date" ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-500"
              checked={options.kind === "date" && options.include_time}
              onChange={(e) => setOptions({ kind: "date", include_time: e.target.checked })}
            />
            {t("field.includeTime")}
          </label>
        ) : field.field_type === "relation" ? (
          <RelationTargetPicker
            currentViewId={field.database_view_id}
            value={options.kind === "relation" ? options.target_view_id : null}
            onChange={(vid) => setOptions({ kind: "relation", target_view_id: vid })}
          />
        ) : (
          <p className="text-[13px] text-neutral-400">{t("field.noOptionsForType")}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save}>{t("common.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 关联字段目标库选择（列出同工作区其它表格视图） */
function RelationTargetPicker(props: { currentViewId: string | null; value: string | null; onChange: (viewId: string | null) => void }) {
  const { currentViewId, value, onChange } = props;
  const tree = useWorkspaceStore((s) => s.tree);
  const gridViews = flattenTree(tree).filter((v) => v.layout === "grid" && v.id !== currentViewId);
  return (
    <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
      {t("field.relationTarget")}
      <select
        className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-[13px] outline-none focus:border-brand-500"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">— {t("field.relationNone")} —</option>
        {gridViews.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {gridViews.length === 0 && <span className="text-[11px] text-neutral-400">{t("field.relationNoViews")}</span>}
    </label>
  );
}
