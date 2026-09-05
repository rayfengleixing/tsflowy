import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { pagePropertiesApi, type PagePropertyFieldType, type PagePropertyRow } from "@/lib/page-properties";
import { registerCloseFlush } from "@/lib/close-flush";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import type { View } from "@/types/models";
import { FieldTypeMenu } from "@/features/database/FieldTypeMenu";

const PROPERTIES_SAVE_MS = 500;

/** 页面属性可选类型（005 迁移 CHECK 约束） */
const PP_TYPES = ["text", "date", "single_select", "multi_select", "number", "checkbox"] as const;

/** 新属性默认 key 去重：统一叫「属性/属性 2/属性 3…」（(view_id,key) 唯一约束） */
function uniqueKey(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

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

  // 属性值防抖落库：键击只更新本地 rows，停顿 500ms / 失焦 / 切页 / 关窗才真正写库
  const pendingRef = useRef(new Map<string, { value: string; fieldType: PagePropertyFieldType; timer: number }>());
  const flushKey = useCallback((vid: string, key: string): Promise<void> => {
    const entry = pendingRef.current.get(key);
    if (!entry) return Promise.resolve();
    window.clearTimeout(entry.timer);
    pendingRef.current.delete(key);
    return pagePropertiesApi.set(vid, key, entry.value, entry.fieldType).catch(() => {
      // 写失败：回滚 UI 状态（重新拉取）
      void pagePropertiesApi.list(vid).then(setRows);
    });
  }, []);
  const flushAllPending = useCallback(
    (vid: string) => {
      const keys = [...pendingRef.current.keys()];
      return Promise.allSettled(keys.map((key) => flushKey(vid, key))).then(() => undefined);
    },
    [flushKey],
  );

  // 切换文档/卸载时冲刷挂起写；并注册进关窗冲刷链（close-flush）
  useEffect(() => {
    const unregister = registerCloseFlush(() => flushAllPending(viewId));
    return () => {
      unregister();
      void flushAllPending(viewId);
    };
  }, [viewId, flushAllPending]);

  const setValue = (row: PagePropertyRow, nextVal: string) => {
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: nextVal } : r)));
    const prev = pendingRef.current.get(row.key);
    if (prev) window.clearTimeout(prev.timer);
    const vid = viewId;
    const timer = window.setTimeout(() => void flushKey(vid, row.key), PROPERTIES_SAVE_MS);
    pendingRef.current.set(row.key, { value: nextVal, fieldType: row.field_type, timer });
  };

  const addRow = async () => {
    // 直接新建文本属性行；名称/类型后续通过点名称（重命名）和点图标（改类型）调整
    const key = uniqueKey(
      t("prop.defaultKey"),
      rows.map((r) => r.key),
    );
    try {
      await pagePropertiesApi.set(viewId, key, "", "text");
      setRows(await pagePropertiesApi.list(viewId));
    } catch (e: unknown) {
      console.error("add page property failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const changeType = async (key: string, nextType: PagePropertyFieldType) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    // 取消挂起防抖写：其 fieldType 是旧类型，若晚于类型变更落库会把类型改回去
    const pending = pendingRef.current.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingRef.current.delete(key);
    }
    try {
      // upsert 保留 position，value 原样保留
      await pagePropertiesApi.set(viewId, key, row.value, nextType);
      setRows(await pagePropertiesApi.list(viewId));
    } catch (e: unknown) {
      console.error("change property type failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const removeKey = async (key: string) => {
    // 先取消挂起写，避免删除后又被防抖写库复活
    const pending = pendingRef.current.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingRef.current.delete(key);
    }
    try {
      await pagePropertiesApi.remove(viewId, key);
      setRows(await pagePropertiesApi.list(viewId));
    } catch (e: unknown) {
      console.error("remove page property failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const renameKey = async (oldKey: string, newKey: string) => {
    if (!newKey.trim() || newKey === oldKey) return;
    try {
      await flushKey(viewId, oldKey); // 先冲刷挂起值再改名，避免刚输入的内容丢失在旧键下
      await pagePropertiesApi.rename(viewId, oldKey, newKey);
      setRows(await pagePropertiesApi.list(viewId));
    } catch (e: unknown) {
      console.error("rename page property failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  if (!slot) return null;

  return createPortal(
    <div className="mb-2 flex flex-col gap-0.5">
      {rows.map((row) => (
        <PropertyRow
          key={row.key}
          row={row}
          onChange={(v) => setValue(row, v)}
          onFlush={() => void flushKey(viewId, row.key)}
          onRemove={() => removeKey(row.key)}
          onRename={(nk) => renameKey(row.key, nk)}
          onChangeType={(nt) => void changeType(row.key, nt)}
        />
      ))}
      <button
        type="button"
        data-testid="add-prop"
        onClick={() => void addRow()}
        className="flex items-center gap-1.5 px-3 py-1 text-[12px] text-neutral-500 hover:text-neutral-800"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("prop.add")}
      </button>
    </div>,
    slot,
  );
}

/** 行样式对齐 RowDetail 的 RowPropertyField：图标 + 字段名(w-20) + 值(flex-1 hover 底色) */
function PropertyRow({
  row,
  onChange,
  onFlush,
  onRemove,
  onRename,
  onChangeType,
}: {
  row: PagePropertyRow;
  onChange: (v: string) => void;
  onFlush: () => void;
  onRemove: () => void;
  onRename: (k: string) => void;
  onChangeType: (t: PagePropertyFieldType) => void;
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
              onChange={(e) => {
                onChange(e.target.checked ? "1" : "0");
                onFlush(); // 勾选是单次操作，立即落库
              }}
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
            onBlur={onFlush}
            className="w-full cursor-pointer bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
      case "number":
        return (
          <input
            type="number"
            value={val}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onFlush}
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
            onBlur={onFlush}
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
            onBlur={onFlush}
            placeholder={t("prop.placeholder")}
            className="w-full bg-transparent text-[12px] text-neutral-800 outline-none"
          />
        );
    }
  })();

  return (
    <div className="group flex items-center gap-2 px-3 py-1 text-[12px]">
      <FieldTypeMenu
        testid="prop-icon"
        types={PP_TYPES}
        current={row.field_type}
        onSelect={(type) => onChangeType(type as PagePropertyFieldType)}
      />
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
