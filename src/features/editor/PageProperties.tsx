import { useEffect, useState } from "react";
import { pagePropertiesApi, type PagePropertyFieldType, type PagePropertyRow } from "@/lib/page-properties";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

/**
 * PageProperties（A 回滚功能，暂不挂 EditorPage，待用户另行确认是否接入）。
 *
 * 保留文件便于后续挂接到 EditorPage 顶部标题栏下方：
 *   <PageProperties view={view} />
 *
 * 类型约束：text / date / single_select / multi_select / number / checkbox（对应 005 表 CHECK）
 */
export function PageProperties({ view }: { view: View }) {
  const viewId = view.id;
  const [rows, setRows] = useState<PagePropertyRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addType, setAddType] = useState<PagePropertyFieldType>("text");

  useEffect(() => {
    pagePropertiesApi
      .list(viewId)
      .then(setRows)
      .catch(() => {
        // 旧库可能没有 page_properties 表（005 是迁移新增）—— 视为空，不 toast（避免打扰非文档布局）
      });
  }, [viewId]);

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

  return (
    <div className="border-b border-neutral-200 bg-neutral-50/60 px-6 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {rows.map((row) => (
          <Chip
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
          className="rounded-full border border-dashed border-neutral-300 px-3 py-0.5 text-[12px] text-neutral-500 hover:border-brand-400 hover:text-brand-600"
        >
          + {t("prop.add")}
        </button>
      </div>
      {addOpen && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <input
            className="h-7 rounded-md border border-neutral-300 px-2 outline-none focus:border-brand-500"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            placeholder={t("prop.namePlaceholder")}
          />
          <select
            className="h-7 rounded-md border border-neutral-300 bg-white px-1"
            value={addType}
            onChange={(e) => setAddType(e.target.value as PagePropertyFieldType)}
          >
            {(["text","date","single_select","multi_select","number","checkbox"] as PagePropertyFieldType[]).map((t_) => (
              <option key={t_} value={t_}>{t_}</option>
            ))}
          </select>
          <button type="button" onClick={addRow} className="rounded bg-brand-500 px-2 py-1 text-white hover:bg-brand-600">
            {t("common.confirm")}
          </button>
        </div>
      )}
    </div>
  );
}

function Chip({
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
          <label className="flex items-center gap-1 text-[11px] text-neutral-500">
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
            className="h-5 rounded border border-neutral-300 bg-white px-1 text-[11px] text-neutral-600 outline-none"
          />
        );
      case "number":
        return (
          <input
            type="number"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            className="h-5 w-20 rounded border border-neutral-300 bg-white px-1 text-[11px] text-neutral-600 outline-none"
          />
        );
      case "multi_select": {
        let arr: string[] = [];
        try { arr = JSON.parse(val || "[]"); } catch { /* keep empty */ }
        return (
          <input
            type="text"
            value={arr.join(", ")}
            onChange={(e) => {
              const next = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
              onChange(JSON.stringify(next));
            }}
            placeholder={t("prop.placeholder")}
            className="h-5 w-28 rounded border border-neutral-300 bg-white px-1 text-[11px] text-neutral-600 outline-none"
          />
        );
      }
      case "single_select":
        return (
          <input
            type="text"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("prop.placeholder")}
            className="h-5 w-24 rounded border border-neutral-300 bg-white px-1 text-[11px] text-neutral-600 outline-none"
          />
        );
      default:
        return (
          <input
            type="text"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("prop.placeholder")}
            className="h-5 w-32 rounded border border-neutral-300 bg-white px-1 text-[11px] text-neutral-600 outline-none"
          />
        );
    }
  })();

  return (
    <div className="flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[12px] shadow-sm">
      {editKey ? (
        <input
          autoFocus
          className="h-5 w-20 rounded border border-neutral-300 px-1 text-[12px] outline-none"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => { setEditKey(false); onRename(keyDraft); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditKey(false); }}
        />
      ) : (
        <button
          type="button"
          className="max-w-[90px] truncate px-1 font-medium text-neutral-700 hover:text-brand-600"
          onClick={() => { setKeyDraft(row.key); setEditKey(true); }}
          title={t("prop.rename")}
        >
          {row.key}
        </button>
      )}
      <span className="text-neutral-300">:</span>
      {content}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 h-4 w-4 rounded-full text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
        title={t("common.delete")}
      >×</button>
    </div>
  );
}
