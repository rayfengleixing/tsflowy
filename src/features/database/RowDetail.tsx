import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDatabaseStore } from "@/stores/database";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { cn } from "@/lib/utils";
import type { View } from "@/types/models";
import { EditorPage } from "@/features/editor/EditorPage";
import { CellEditorSlot, SelectChips } from "./editors";
import { fieldIcon } from "./field-icon";
import { NewFieldDialog } from "./NewFieldDialog";
import { t } from "@/lib/i18n";

/** 行详情属性区：可编辑该行的全部字段值，样式对齐 AppFlowy（图标 + 字段名 + 值） */
function RowPropertyField({ field, row }: { field: DatabaseField; row: DatabaseRow }) {
  const store = useDatabaseStore();
  const [editing, setEditing] = useState(false);
  const value = store.cells[row.id]?.[field.id] ?? null;

  const commit = (v: CellValue) => {
    setEditing(false);
    void store.setCell(row.id, field.id, v);
  };

  const display = (() => {
    if (field.field_type === "single_select" || field.field_type === "multi_select") {
      return <SelectChips field={field} value={value} />;
    }
    const text = formatCellValue(field.field_type, value, parseFieldOptions(field.options));
    return (
      <span
        className={cn(
          isReadonlyType(field.field_type)
            ? "text-neutral-400"
            : value !== null
              ? "text-neutral-800"
              : "text-neutral-300",
        )}
      >
        {text || t("rowDetail.empty")}
      </span>
    );
  })();

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px]">
      {fieldIcon(field.field_type)}
      <span className="w-20 shrink-0 truncate text-neutral-600">{field.name}</span>
      <div
        className="min-w-0 flex-1 cursor-text rounded px-1.5 py-0.5 hover:bg-neutral-100"
        onClick={() => !isReadonlyType(field.field_type) && setEditing(true)}
      >
        {editing ? (
          <CellEditorSlot
            field={field}
            value={value}
            onCommit={commit}
            onCancel={() => setEditing(false)}
            onAddOption={(name) => {
              void store.addSelectOption(field.id, name);
              return null;
            }}
            onDeleteOption={(optId) => void store.removeSelectOption(field.id, optId)}
          />
        ) : (
          display
        )}
      </div>
    </div>
  );
}

/** 行详情右侧滑出面板（说明书 6.1：宽 400px，右侧滑入 + 遮罩 + 滑入动画），复用 M3 编辑器 */
export function RowDetailPanel({ row, view, onClose }: { row: DatabaseRow; view: View; onClose: () => void }) {
  const store = useDatabaseStore();
  const visibleFields = store.fields.filter((f) => f.is_hidden === 0);
  const [newFieldOpen, setNewFieldOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-50">
      {/* 遮罩：淡入动画（说明书 6.1：半透明黑） */}
      <div className="absolute inset-0 animate-in fade-in bg-black/20 duration-200" onClick={onClose} />
      {/* 右侧 400px 面板：滑入动画 */}
      <div
        className={
          "absolute right-0 top-0 flex h-full w-[400px] flex-col bg-white shadow-2xl " +
          "animate-in slide-in-from-right duration-300 ease-out " +
          "border-l border-neutral-200 dark:border-neutral-700"
        }
      >
        {/* 顶部：行名 + 关闭 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-700">
          <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-neutral-900">{view.name}</span>
          <button
            data-testid="close-row-detail"
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* 属性区 */}
        <div className="flex flex-col gap-0.5 border-b border-neutral-200 px-4 pb-2">
          {visibleFields.map((f) => (
            <RowPropertyField key={f.id} field={f} row={row} />
          ))}
          <button
            className="flex items-center gap-1.5 px-3 py-1 text-[12px] text-neutral-500 hover:text-neutral-800"
            onClick={() => setNewFieldOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("field.addColumn")}
          </button>
        </div>
        {/* 正文文档 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <EditorPage view={view} hideSlash />
        </div>
      </div>
      <NewFieldDialog
        open={newFieldOpen}
        onOpenChange={setNewFieldOpen}
        onCreate={async (name, type) => {
          try {
            await store.addField(type, name);
            setNewFieldOpen(false);
          } catch (e) {
            console.error("add field failed", e);
          }
        }}
      />
    </div>
  );
}
