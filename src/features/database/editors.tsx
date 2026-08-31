import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import type { CellValue, DatabaseField, SelectOption } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { parseFieldOptions } from "@/lib/database-values";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// 单元格内联编辑器（项目说明书 10-M4：每字段类型一个专用编辑器）
// 交互约定：Enter 提交、Esc 取消、失焦提交；select 类用 Popover。

export interface CellEditorProps {
  field: DatabaseField;
  value: CellValue;
  onCommit: (value: CellValue) => void;
  onCancel: () => void;
  /** 在选项下拉里直接新建选项（单选/多选），返回新选项 id 供选中 */
  onAddOption?: (name: string) => string | null;
  /** 删除一个选项（单选/多选），引用该选项的单元格会被清空 */
  onDeleteOption?: (optionId: string) => void;
}

/** 下拉内的"添加选项"输入 */
function AddOptionInput({ onAdd }: { onAdd: (name: string) => string | null }) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex items-center gap-1.5 px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const v = name.trim();
        if (v) {
          onAdd(v);
          setName("");
        }
      }}
    >
      <Plus className="h-3.5 w-3.5 text-neutral-400" />
      <input
        className="flex-1 border-none bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
        placeholder="添加选项…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </form>
  );
}

function useAutoFocus<T extends HTMLInputElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return ref;
}

/** 文本类（text/url/phone/email） */
export function TextCellEditor({ field, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useAutoFocus<HTMLInputElement>();
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  return (
    <input
      ref={ref}
      className="h-full w-full bg-transparent px-2 text-[13px] outline-none"
      value={draft}
      placeholder={field.field_type === "url" ? "https://…" : field.field_type === "email" ? "name@example.com" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(draft.trim() === "" ? null : draft);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(draft.trim() === "" ? null : draft)}
    />
  );
}

/** 数字类（number）：留空提交 null */
export function NumberCellEditor({ field: _field, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useAutoFocus<HTMLInputElement>();
  const [draft, setDraft] = useState(typeof value === "number" ? String(value) : "");
  return (
    <input
      ref={ref}
      type="number"
      step="any"
      className="h-full w-full bg-transparent px-2 text-[13px] outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const t = draft.trim();
          const n = t === "" ? null : Number(t);
          onCommit(n !== null && Number.isFinite(n) ? n : null);
        }
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => {
        const t = draft.trim();
        const n = t === "" ? null : Number(t);
        onCommit(n !== null && Number.isFinite(n) ? n : null);
      }}
    />
  );
}

/** 日期类（date）：include_time 时用 datetime-local，存 ISO */
export function DateCellEditor({ field, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useAutoFocus<HTMLInputElement>();
  const opts = parseFieldOptions(field.options);
  const includeTime = opts.kind === "date" && opts.include_time;
  const [draft, setDraft] = useState(() => {
    if (typeof value !== "string") return "";
    if (includeTime) {
      const d = new Date(value.endsWith("Z") ? value : value + "Z");
      if (Number.isNaN(d.getTime())) return value;
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return value.slice(0, 10);
  });
  const commit = () => {
    if (!draft.trim()) {
      onCommit(null);
      return;
    }
    if (includeTime) {
      const d = new Date(draft);
      onCommit(Number.isNaN(d.getTime()) ? null : d.toISOString());
    } else {
      onCommit(draft.slice(0, 10));
    }
  };
  return (
    <input
      ref={ref}
      type={includeTime ? "datetime-local" : "date"}
      className="h-full w-full bg-transparent px-2 text-[13px] outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={commit}
    />
  );
}

/** 单选（single_select）：Popover 选项列表 */
export function SelectCellEditor({ field, value, onCommit, onCancel, onAddOption, onDeleteOption }: CellEditorProps) {
  const opts = parseFieldOptions(field.options);
  const options = opts.kind === "select" ? opts.options : [];
  const selected = typeof value === "string" ? value : null;
  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-56 overflow-y-auto rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        {options.length === 0 && <div className="px-2 py-1.5 text-[12px] text-neutral-400">暂无选项</div>}
        {options.map((o) => (
          <button
            key={o.id}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-neutral-200/60", selected === o.id && "bg-brand-100")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onCommit(o.id);
            }}
          >
            <OptionDot option={o} />
            <span className="flex-1">{o.name}</span>
            {selected === o.id && <Check className="h-3.5 w-3.5 text-brand-600" />}
            {onDeleteOption && (
              <span
                className="flex h-4 w-4 items-center justify-center rounded text-neutral-300 hover:bg-neutral-200 hover:text-red-500"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteOption(o.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommit(null)}
        >
          <X className="h-3.5 w-3.5" />
          清除
        </button>
        {onAddOption && (
          <div className="mt-0.5 border-t border-neutral-200 pt-0.5">
            <AddOptionInput onAdd={onAddOption} />
          </div>
        )}
      </div>
      {/* 点击外部取消 */}
      <div className="fixed inset-0 z-10" onMouseDown={() => onCancel()} />
    </div>
  );
}

/** 多选（multi_select）：Popover 勾选多个选项 */
export function MultiSelectCellEditor({ field, value, onCommit, onAddOption, onDeleteOption }: CellEditorProps) {
  const opts = parseFieldOptions(field.options);
  const options = opts.kind === "select" ? opts.options : [];
  const selected = new Set(Array.isArray(value) ? value : []);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCommit([...next]);
  };
  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-56 overflow-y-auto rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        {options.length === 0 && <div className="px-2 py-1.5 text-[12px] text-neutral-400">暂无选项</div>}
        {options.map((o) => (
          <button
            key={o.id}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-neutral-200/60", selected.has(o.id) && "bg-brand-100")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(o.id)}
          >
            <OptionDot option={o} />
            <span className="flex-1">{o.name}</span>
            {selected.has(o.id) && <Check className="h-3.5 w-3.5 text-brand-600" />}
            {onDeleteOption && (
              <span
                className="flex h-4 w-4 items-center justify-center rounded text-neutral-300 hover:bg-neutral-200 hover:text-red-500"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteOption(o.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
        {onAddOption && (
          <div className="mt-0.5 border-t border-neutral-200 pt-0.5">
            <AddOptionInput onAdd={onAddOption} />
          </div>
        )}
      </div>
      <div className="fixed inset-0 z-10" onMouseDown={() => undefined} />
    </div>
  );
}

/** 复选框（checkbox）：点击即切换 */
export function CheckboxCellEditor({ field: _field, value, onCommit }: CellEditorProps) {
  return (
    <button
      className="flex h-full w-full items-center justify-center"
      onClick={() => onCommit(value !== true)}
    >
      <span className={cn("flex h-4 w-4 items-center justify-center rounded border", value === true ? "border-brand-500 bg-brand-500 text-white" : "border-neutral-300 bg-white")}>
        {value === true && <Check className="h-3 w-3" />}
      </span>
    </button>
  );
}

/** 单选/多选选项彩色圆点 */
export function OptionDot({ option }: { option: SelectOption }) {
  const colors: Record<string, string> = {
    blue: "bg-brand-500",
    green: "bg-green-500",
    orange: "bg-orange-500",
    purple: "bg-purple-500",
    red: "bg-red-500",
    yellow: "bg-yellow-400",
    gray: "bg-neutral-400",
  };
  return <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", colors[option.color] ?? "bg-neutral-400")} />;
}

/** 按字段类型分派编辑器（GridView 单元格 + 行详情属性区共用） */
export function CellEditorSlot(props: {
  field: DatabaseField;
  value: CellValue;
  onCommit: (v: CellValue) => void;
  onCancel: () => void;
  onAddOption?: (name: string) => string | null;
  onDeleteOption?: (optionId: string) => void;
}) {
  const { field, value, onCommit, onCancel, onAddOption, onDeleteOption } = props;
  switch (field.field_type) {
    case "number":
      return <NumberCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "date":
      return <DateCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "checkbox":
      return <CheckboxCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "single_select":
      return <SelectCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} onAddOption={onAddOption} onDeleteOption={onDeleteOption} />;
    case "multi_select":
      return <MultiSelectCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} onAddOption={onAddOption} onDeleteOption={onDeleteOption} />;
    case "relation":
      return <RelationCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    default:
      return <TextCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
  }
}

/** 只读时间（created_at / last_edited_at）显示用，无编辑器 */
export { isReadonlyType };
export { ChevronDown };

/** 关联字段编辑器：从目标表格选对端行（多选），存对端 row_id 数组 */
export function RelationCellEditor({ field, value, onCommit }: CellEditorProps) {
  const opts = parseFieldOptions(field.options);
  const targetViewId = opts.kind === "relation" ? opts.target_view_id : null;
  const [rows, setRows] = useState<{ id: string; label: string }[]>([]);
  const selected = new Set(Array.isArray(value) ? value : []);

  useEffect(() => {
    let alive = true;
    if (!targetViewId) return;
    import("@/lib/relation").then(({ getTargetRows }) =>
      getTargetRows(targetViewId as string).then((r) => {
        if (alive) setRows(r);
      }),
    );
    return () => {
      alive = false;
    };
  }, [targetViewId]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCommit([...next]);
  };

  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-56 overflow-y-auto rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        {!targetViewId && <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("relation.noTarget")}</div>}
        {targetViewId && rows.length === 0 && <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("relation.noRows")}</div>}
        {rows.map((r) => (
          <button
            key={r.id}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-neutral-200/60", selected.has(r.id) && "bg-brand-100")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(r.id)}
          >
            <span className="flex-1 truncate">{r.label}</span>
            {selected.has(r.id) && <Check className="h-3.5 w-3.5 text-brand-600" />}
          </button>
        ))}
      </div>
      <div className="fixed inset-0 z-10" onMouseDown={() => undefined} />
    </div>
  );
}