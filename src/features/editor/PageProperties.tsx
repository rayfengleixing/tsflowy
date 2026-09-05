import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { pagePropertiesApi, type PagePropertyFieldType, type PagePropertyRow } from "@/lib/page-properties";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { fieldIcon } from "@/features/database/field-icon";

/**
 * PageProperties：页面属性区，portal 渲染进 PagePropertiesSlot 扩展提供的挂载点
 * （文档首个 H1 之后的 widget div），即「标题下方」；行样式对齐行详情属性区
 * （图标 + 字段名 + 值，12px）。文档无 H1 时挂载点不存在，本组件不渲染任何内容。
 *
 * 类型约束：text / date / single_select / multi_select / number / checkbox（对应 005 表 CHECK）
 */
export function PageProperties({ view, editor }: { view: View; editor: Editor | null | undefined }) {
  const viewId = view.id;
  const [rows, setRows] = useState<PagePropertyRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addType, setAddType] = useState<PagePropertyFieldType>("text");
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    pagePropertiesApi
      .list(viewId)
      .then(setRows)
      .catch(() => {
        // 旧库可能没有 page_properties 表（005 是迁移新增）—— 视为空，不 toast（避免打扰非文档布局）
      });
  }, [viewId]);

  // 跟踪编辑器里的挂载点（内容加载/标题增删都会让它出现或消失）
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setSlot(null);
      return;
    }
    const host = editor.view.dom;
    const check = () => setSlot(host.querySelector<HTMLElement>("[data-page-properties-slot]"));
    check();
    const mo = new MutationObserver(check);
    mo.observe(host, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [editor]);

  const setValue = (row: PagePropertyRow, nextVal: string) => {
    const nextRows = rows.map((r) => (r.key === row.key ? { ...r, value: nextVal } : r));
    setRows(nextRows);
    pagePropertiesApi.set(viewId, row.key, nextVal, row.field_type).catch(() => {
      // 写失败：回滚 UI 状态（重新拉取）
      void pagePropertiesApi.list(viewId).then(setRows);
    });
  };

  const addRow = async () => {
    const key = addKey.trim();
    if (!key) return;
    const initValue = addType === "checkbox" ? "0" : addType === "multi_select" ? "[]" : "";
    await pagePropertiesApi.set(viewId, key, initValue, addType);
    setRows(await pagePropertiesApi.list(viewId));
    setAddKey("");
    setAddOpen(false);
  };

  const removeKey = async (key: string) => {
    await pagePropertiesApi.remove(viewId, key);
    setRows(await pagePropertiesApi.list(viewId));
  };

  const renameKey = async (oldKey: string, newKey: string) => {
    if (!newKey.trim() || newKey === oldKey) return;
    await pagePropertiesApi.rename(viewId, oldKey, newKey);
    setRows(await pagePropertiesApi.list(viewId));
  };

  if (!slot) return null;

  return createPortal(
    <div className="mb-2 flex flex-col gap-0.5">
      {rows.map((row) => (
        <PropertyRow
          key={row.key}
          row={row}
          onChange={(v) => setValue(row, v)}
          onRemove={() => removeKey(row.key)}
          onRename={(nk) => renameKey(row.key, nk)}
        />
      ))}
      <button
        type="button"
        onClick={() => setAddOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1 text-[12px] text-neutral-500 hover:text-neutral-800"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("prop.add")}
      </button>
      {addOpen && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-[12px]">
          <input
            className="h-6 rounded-md border border-neutral-300 px-2 outline-none focus:border-brand-500"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            placeholder={t("prop.namePlaceholder")}
          />
          <select
            className="h-6 rounded-md border border-neutral-300 bg-white px-1"
            value={addType}
            onChange={(e) => setAddType(e.target.value as PagePropertyFieldType)}
          >
            {(["text", "date", "single_select", "multi_select", "number", "checkbox"] as PagePropertyFieldType[]).map(
              (t_) => (
                <option key={t_} value={t_}>
                  {t_}
                </option>
              ),
            )}
          </select>
          <button
            type="button"
            onClick={addRow}
            className="rounded bg-brand-500 px-2 py-0.5 text-white hover:bg-brand-600"
          >
            {t("common.confirm")}
          </button>
        </div>
      )}
    </div>,
    slot,
  );
}

/** 行样式对齐 RowDetail 的 RowPropertyField：图标 + 字段名(w-20) + 值(flex-1 hover 底色) */
function PropertyRow({
  row,
  onChange,
  onRemove,
  onRename,
}: {
  row: PagePropertyRow;
  onChange: (v: string) => void;
  onRemove: () => void;
  onRename: (k: string) => void;
}) {
  const [editKey, setEditKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(row.key);
  const val = row.value;

  const content = (() => {
    switch (row.field_type) {
      case "checkbox":
        return (
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-neutral-600">
            <input
              type="checkbox"
              checked={val === "1"}
              onChange={(e) => onChange(e.target.checked ? "1" : "0")}
              className="h-3 w-3"
            />
            {t("prop.checkbox")}
          </label>
        );
      case "date":
        return (
          <input
            type="date"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            className="w-full cursor-pointer bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
      case "number":
        return (
          <input
            type="number"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            className="w-24 bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
      case "multi_select": {
        let arr: string[] = [];
        try {
          arr = JSON.parse(val || "[]");
        } catch {
          /* keep empty */
        }
        return (
          <input
            type="text"
            value={arr.join(", ")}
            onChange={(e) => {
              const next = e.target.value
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean);
              onChange(JSON.stringify(next));
            }}
            placeholder={t("prop.placeholder")}
            className="w-full bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
      }
      default:
        return (
          <input
            type="text"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("prop.placeholder")}
            className="w-full bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
    }
  })();

  return (
    <div className="group flex items-center gap-2 px-3 py-1 text-[12px]">
      {fieldIcon(row.field_type)}
      {editKey ? (
        <input
          autoFocus
          className="h-5 w-20 shrink-0 rounded border border-neutral-300 px-1 text-[12px] outline-none"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => {
            setEditKey(false);
            onRename(keyDraft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditKey(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="w-20 shrink-0 truncate text-left text-neutral-600 hover:text-neutral-800"
          onClick={() => {
            setKeyDraft(row.key);
            setEditKey(true);
          }}
          title={t("prop.rename")}
        >
          {row.key}
        </button>
      )}
      <div className="min-w-0 flex-1 rounded px-1.5 py-0.5 hover:bg-neutral-100">{content}</div>
      <button
        type="button"
        onClick={onRemove}
        className="h-4 w-4 shrink-0 rounded text-neutral-300 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-700 group-hover:opacity-100"
        title={t("common.delete")}
      >
        ×
      </button>
    </div>
  );
}
