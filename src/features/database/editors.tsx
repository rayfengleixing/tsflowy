import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { AttachmentRef, CellValue, DatabaseField, SelectOption } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { attachmentRefs, parseFieldOptions } from "@/lib/database-values";
import { filesFromDataTransfer, openAttachment, pickAttachment, saveAttachmentFile } from "@/lib/assets";
import { relationRowIds, relationRowLabel, relationTarget, searchRelationRows } from "@/lib/relation";
import { useRelationStore } from "@/stores/relation";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { AttachmentThumb, OptionChip, RelationChip } from "./cell-display";

// 只读展示类部件（选项/关联/附件胶囊、缩略图）已拆到 cell-display.tsx，
// 这里重新转出，保持 editors.tsx 对外的导出 API 完全不变。
export {
  AttachmentChip,
  AttachmentChips,
  OptionDot,
  RelationChip,
  RelationChips,
  ReverseRelationChips,
  SelectChips,
} from "./cell-display";

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
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []),
  );
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

  /** 删除选项前先移出本地 draft：否则 outside-click 提交时会把刚删掉的悬空 id 重新写回单元格 */
  const removeOption = (id: string) => {
    setDraft((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onDeleteOption?.(id);
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
              onDelete={onDeleteOption ? () => removeOption(o.id) : undefined}
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

/**
 * 附件（attachment）：三种添加方式——系统文件对话框选择、把文件拖进面板、直接粘贴（Ctrl+V）。
 * 后两种拿到的是 File，走 save_asset_bytes 存字节流，不依赖对话框路径白名单。
 * 与多选一致：改动先攒在本地 draft，outside-click / Esc 才落库。
 */
export function AttachmentCellEditor({ value, onCommit }: CellEditorProps) {
  const [draft, setDraft] = useState<AttachmentRef[]>(() => attachmentRefs(value));
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const commit = () => onCommit(draft);

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    try {
      const added: AttachmentRef[] = [];
      for (const file of files) added.push(await saveAttachmentFile(file, t("field.attachmentPastedName")));
      setDraft((prev) => [...prev, ...added]);
    } catch (e) {
      logger.error("attachment.upload", e);
      toast.error(t("error.upload", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  // 粘贴：编辑器只在该单元格处于编辑态时挂载，因此文档级监听等价于"只处理此单元格的粘贴"
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromDataTransfer(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ref = await pickAttachment();
      if (ref) setDraft((prev) => [...prev, ref]);
    } catch (e) {
      logger.error("attachment.upload", e);
      toast.error(t("error.upload", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const open = async (path: string) => {
    try {
      await openAttachment(path);
    } catch (e) {
      logger.error("attachment.open", e);
      toast.error(t("error.openAttachment", { message: String(e) }));
    }
  };

  const remove = (path: string) => setDraft((prev) => prev.filter((a) => a.path !== path));

  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div
        className={cn(
          "absolute inset-x-0 top-full z-20 mt-0.5 flex max-h-64 flex-col rounded-lg border bg-white p-1 shadow-lg",
          dragOver ? "border-brand-500 ring-1 ring-brand-300" : "border-neutral-300",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles(filesFromDataTransfer(e.dataTransfer));
        }}
      >
        <button
          type="button"
          disabled={busy}
          className="mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2 text-left text-[12px] text-neutral-600 hover:border-brand-500 hover:text-brand-600 disabled:opacity-60"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void add()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("field.attachmentAdd")}
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          {dragOver ? (
            <div className="px-2 py-3 text-center text-[12px] text-brand-600">{t("field.attachmentDropHint")}</div>
          ) : draft.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.attachmentEmpty")}</div>
          ) : (
            draft.map((a) => (
              <div
                key={a.path}
                className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-neutral-200/60"
              >
                <AttachmentThumb name={a.name} path={a.path} />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void open(a.path)}
                >
                  {a.name}
                </button>
                <button
                  type="button"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500"
                  title={t("common.delete")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => remove(a.path)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
        <div className="mt-1 shrink-0 px-2 pb-0.5 text-[11px] text-neutral-400">{t("field.attachmentPasteHint")}</div>
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

/**
 * 关联（relation）：从目标库挑选若干行。
 * 与多选同样的交互：点击/回车加选，不立即提交，outside-click / Esc 才落库。
 */
export function RelationCellEditor({ field, value, onCommit, onCancel }: CellEditorProps) {
  const targetId = relationTarget(field);
  const db = useRelationStore((s) => (targetId ? s.data[targetId] : undefined));
  const ensure = useRelationStore((s) => s.ensure);
  useEffect(() => {
    if (targetId) ensure([targetId]);
  }, [targetId, ensure]);

  const [draft, setDraft] = useState<Set<string>>(() => new Set(relationRowIds(value)));
  const [query, setQuery] = useState("");
  const inputRef = useAutoFocus<HTMLInputElement>();
  const candidates = db ? searchRelationRows(db, query).slice(0, 50) : [];

  const toggle = (id: string) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const commit = () => onCommit([...draft]);

  const labelOf = (id: string) => (db ? relationRowLabel(db, id) : null) ?? id;

  return (
    <div className="absolute inset-0 z-10" onMouseDown={(e) => e.stopPropagation()}>
      <div className="h-full w-full bg-white" />
      <div className="absolute inset-x-0 top-full z-20 mt-0.5 flex max-h-64 flex-col rounded-lg border border-neutral-300 bg-white p-1 shadow-lg">
        {!targetId ? (
          <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.relationUnset")}</div>
        ) : (
          <>
            <div className="relative mb-1 shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                ref={inputRef}
                className="h-7 w-full rounded-md border border-neutral-200 pl-7 pr-2 text-[13px] outline-none placeholder:text-neutral-400 focus:border-brand-500"
                placeholder={t("field.relationSearch")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && candidates[0]) {
                    toggle(candidates[0].id);
                    setQuery("");
                  }
                  if (e.key === "Escape") commit();
                }}
              />
            </div>
            {/* 已选预览：点胶囊上的 X 直接取消关联 */}
            {draft.size > 0 && (
              <div className="mb-1 flex shrink-0 flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                <span className="mr-1 text-[11px] text-neutral-400">
                  {t("field.selected")} {draft.size}
                </span>
                {[...draft].map((id) => (
                  <RelationChip key={id} label={labelOf(id)} onRemove={() => toggle(id)} />
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
              {!db && <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("app.loading")}</div>}
              {db && candidates.length === 0 && (
                <div className="px-2 py-1.5 text-[12px] text-neutral-400">{t("field.relationEmpty")}</div>
              )}
              {candidates.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-neutral-200/60",
                    draft.has(row.id) && "bg-brand-100",
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(row.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{labelOf(row.id)}</span>
                  {draft.has(row.id) && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
                </button>
              ))}
            </div>
            {draft.size > 0 && (
              <button
                type="button"
                className="flex w-full shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-neutral-500 hover:bg-neutral-200/60"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setDraft(new Set())}
              >
                <X className="h-3.5 w-3.5" />
                {t("common.clearAll")}
              </button>
            )}
          </>
        )}
      </div>
      {/* 点击外部：提交当前 draft 并关闭编辑器（目标未配置时等价于取消） */}
      <div className="fixed inset-0 z-10" onMouseDown={() => (targetId ? commit() : onCancel())} />
    </div>
  );
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
    case "relation":
      return <RelationCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    case "attachment":
      return <AttachmentCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
    default:
      return <TextCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />;
  }
}

/** 只读时间（created_at / last_edited_at）显示用，无编辑器 */
export { isReadonlyType };
export { ChevronDown };
