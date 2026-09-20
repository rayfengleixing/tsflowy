import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
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
  /** 在选项下拉里直接新建选项（单选/多选），resolve 新选项 id 供创建后直接选中；失败为 null */
  onAddOption?: (name: string) => Promise<string | null>;
  /** 删除一个选项（单选/多选），引用该选项的单元格会被清空 */
  onDeleteOption?: (optionId: string) => void;
}

/** 下拉搜索：按输入子串过滤选项，并给出精确匹配（回车是"选中已有"还是"新建"据此决定） */
function matchOptions(options: SelectOption[], query: string) {
  const text = query.trim();
  const lower = text.toLowerCase();
  const list = lower ? options.filter((o) => o.name.toLowerCase().includes(lower)) : options;
  const exact = lower ? options.find((o) => o.name.toLowerCase() === lower) : undefined;
  return { text, list, exact };
}

/** 下拉里的选项行：彩色胶囊展示本体；选中打勾；删除按钮仅在鼠标悬停该行时浮现（防误点） */
function SelectOptionRow({
  option,
  active,
  onPick,
  onDelete,
}: {
  option: SelectOption;
  active: boolean;
  onPick: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-neutral-200/60",
        active && "bg-brand-100",
      )}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="flex min-w-0 flex-1 items-center">
        <OptionChip option={option} />
      </span>
      {active && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
      {onDelete && (
        <span
          title={t("common.delete")}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-red-500 group-hover:opacity-100"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}

/** "新建 xxx" 行：输入与现有选项无精确匹配时出现，把输入文本建成新选项并直接选中 */
function CreateOptionRow({ name, onCreate }: { name: string; onCreate: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onCreate}
    >
      <Plus className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("select.createNew", { name })}</span>
    </button>
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

/** 单选（single_select）：顶部搜索——输入即筛选，回车选中精确匹配或新建 */
export function SelectCellEditor({ field, value, onCommit, onCancel, onAddOption, onDeleteOption }: CellEditorProps) {
  const opts = parseFieldOptions(field.options);
  const options = opts.kind === "select" ? opts.options : [];
  const selected = typeof value === "string" ? value : null;
  const [query, setQuery] = useState("");
  const inputRef = useAutoFocus<HTMLInputElement>();
  const { text, list, exact } = matchOptions(options, query);

  const createFromQuery = () => {
    if (!text || !onAddOption) return;
    void onAddOption(text).then((id) => {
      if (id) onCommit(id);
    });
  };

  const submitQuery = () => {
    if (!text) return;
    if (exact) onCommit(exact.id);
    else if (list.length > 0) onCommit(list[0].id);
    else createFromQuery();
  };

  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 flex max-h-64 flex-col rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        <input
          ref={inputRef}
          className="mb-1 h-7 shrink-0 rounded-md border border-neutral-200 px-2 text-[13px] outline-none placeholder:text-neutral-400 focus:border-brand-500"
          placeholder={t("select.searchOrCreate")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitQuery();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          {!text && options.length === 0 && (
            <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.noOptionsShort")}</div>
          )}
          {list.map((o) => (
            <SelectOptionRow
              key={o.id}
              option={o}
              active={selected === o.id}
              onPick={() => onCommit(o.id)}
              onDelete={onDeleteOption ? () => onDeleteOption(o.id) : undefined}
            />
          ))}
          {text && !exact && onAddOption && <CreateOptionRow name={text} onCreate={createFromQuery} />}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommit(null)}
          >
            <X className="h-3.5 w-3.5" />
            {t("common.clear")}
          </button>
        </div>
      </div>
      {/* 点击外部取消 */}
      <div className="fixed inset-0 z-10" onMouseDown={() => onCancel()} />
    </div>
  );
}

/** 多选（multi_select）：顶部搜索；点击/回车加选，连点不关闭——outside-click/Esc 才提交 */
export function MultiSelectCellEditor({ field, value, onCommit, onAddOption, onDeleteOption }: CellEditorProps) {
  const opts = parseFieldOptions(field.options);
  const options = opts.kind === "select" ? opts.options : [];
  // 使用本地 draft：切换时不立即 commit，直到 outside-click 才提交并关闭
  const [draft, setDraft] = useState<Set<string>>(() => new Set(Array.isArray(value) ? value : []));
  const [query, setQuery] = useState("");
  const inputRef = useAutoFocus<HTMLInputElement>();
  const { text, list, exact } = matchOptions(options, query);

  const addToDraft = (id: string) => setDraft((prev) => new Set([...prev, id]));

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commit = () => onCommit([...draft]);

  const createFromQuery = () => {
    if (!text || !onAddOption) return;
    void onAddOption(text).then((id) => {
      if (id) {
        addToDraft(id);
        setQuery("");
      }
    });
  };

  const submitQuery = () => {
    if (!text) return;
    const pick = exact?.id ?? list[0]?.id;
    if (pick) {
      addToDraft(pick);
      setQuery("");
    } else {
      createFromQuery();
    }
  };

  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 flex max-h-64 flex-col rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        <input
          ref={inputRef}
          className="mb-1 h-7 shrink-0 rounded-md border border-neutral-200 px-2 text-[13px] outline-none placeholder:text-neutral-400 focus:border-brand-500"
          placeholder={t("select.searchOrCreate")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitQuery();
            if (e.key === "Escape") commit();
          }}
        />
        {/* 已选胶囊预览（方便用户看到改动；点击胶囊 X 也可移除） */}
        {draft.size > 0 && (
          <div className="mb-1 flex shrink-0 flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
            <span className="mr-1 text-[11px] text-neutral-400">
              {t("field.selected")} {draft.size}
            </span>
            {[...draft].map((id) => {
              const o = options.find((x) => x.id === id);
              if (!o) return null;
              return <OptionChip key={id} option={o} compact onRemove={() => toggle(id)} />;
            })}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          {!text && options.length === 0 && (
            <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.noOptionsShort")}</div>
          )}
          {list.map((o) => (
            <SelectOptionRow
              key={o.id}
              option={o}
              active={draft.has(o.id)}
              onPick={() => toggle(o.id)}
              onDelete={onDeleteOption ? () => onDeleteOption(o.id) : undefined}
            />
          ))}
          {text && !exact && onAddOption && <CreateOptionRow name={text} onCreate={createFromQuery} />}
          {draft.size > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setDraft(new Set())}
            >
              <X className="h-3.5 w-3.5" />
              {t("common.clearAll")}
            </button>
          )}
        </div>
      </div>
      {/* 点击外部：提交当前 draft 并关闭编辑器 */}
      <div className="fixed inset-0 z-10" onMouseDown={() => commit()} />
    </div>
  );
}

/** 复选框（checkbox）：点击即切换 */
export function CheckboxCellEditor({ field: _field, value, onCommit }: CellEditorProps) {
  return (
    <button className="flex h-full w-full items-center justify-center" onClick={() => onCommit(value !== true)}>
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded border",
          value === true ? "border-brand-500 bg-brand-500 text-white" : "border-neutral-300 bg-white",
        )}
      >
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
export function CellEditorSlot(props: CellEditorProps) {
  const { field, value, onCommit, onCancel, onAddOption, onDeleteOption } = props;
  switch (field.field_type) {
    case "number":
      return <NumberCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "date":
    case "created_at":
    case "last_edited_at":
      return <DateCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "checkbox":
      return <CheckboxCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "single_select":
      return (
        <SelectCellEditor
          field={field}
          value={value}
          onCommit={onCommit}
          onCancel={onCancel}
          onAddOption={onAddOption}
          onDeleteOption={onDeleteOption}
        />
      );
    case "multi_select":
      return (
        <MultiSelectCellEditor
          field={field}
          value={value}
          onCommit={onCommit}
          onCancel={onCancel}
          onAddOption={onAddOption}
          onDeleteOption={onDeleteOption}
        />
      );
    default:
      return <TextCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
  }
}

/** 只读时间（created_at / last_edited_at）显示用，无编辑器 */
export { isReadonlyType };
export { ChevronDown };

/** 选项彩色胶囊（单元格显示单选/多选值，带背景色）；compact 用于卡片内紧凑显示；onRemove 提供"输入框中胶囊点 X 删除" */
export function OptionChip({
  option,
  compact = false,
  onRemove,
}: {
  option?: SelectOption;
  compact?: boolean;
  onRemove?: () => void;
}) {
  if (!option) return null;
  const colors: Record<string, string> = {
    blue: "bg-brand-100 text-brand-600",
    green: "bg-green-100 text-green-700",
    orange: "bg-orange-100 text-orange-700",
    purple: "bg-purple-100 text-purple-700",
    red: "bg-red-100 text-red-700",
    yellow: "bg-yellow-100 text-yellow-700",
    gray: "bg-neutral-200 text-neutral-600",
  };
  const size = compact ? "px-1 py-[1px] text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium group/chip",
        size,
        colors[option.color] ?? "bg-neutral-200 text-neutral-600",
      )}
    >
      <span className="max-w-[180px] truncate">{option.name}</span>
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-current/70 hover:bg-black/10 hover:text-current"
          title={t("field.removeOption")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

/** 单选/多选单元格值 → 彩色胶囊展示；compact 用于卡片内紧凑显示；onRemove 启用胶囊 X 删除按钮 */
export function SelectChips({
  field,
  value,
  compact = false,
  onRemove,
}: {
  field: DatabaseField;
  value: CellValue;
  compact?: boolean;
  onRemove?: (newValue: CellValue) => void;
}) {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "select") return null;
  if (field.field_type === "single_select") {
    if (typeof value !== "string") return null;
    return (
      <OptionChip
        option={opts.options.find((x) => x.id === value)}
        compact={compact}
        onRemove={onRemove ? () => onRemove(null) : undefined}
      />
    );
  }
  const ids = Array.isArray(value) ? value : [];
  return (
    <span className={cn("flex flex-wrap", compact ? "gap-0.5" : "gap-1")}>
      {ids.map((id) => (
        <OptionChip
          key={id}
          option={opts.options.find((x) => x.id === id)}
          compact={compact}
          onRemove={onRemove ? () => onRemove(ids.filter((x) => x !== id)) : undefined}
        />
      ))}
    </span>
  );
}
