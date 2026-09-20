import { useMemo, useState } from "react";
import { Maximize2, Minimize2, Plus, X } from "lucide-react";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { FIELD_TYPES, isReadonlyType, type FieldType } from "@/types/database";
import { useDatabaseStore } from "@/stores/database";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { computeFormula } from "@/lib/database-formula";
import { cn } from "@/lib/utils";
import type { View } from "@/types/models";
import { EditorPage } from "@/features/editor/EditorPage";
import { CellEditorSlot, SelectChips } from "./editors";
import { fieldIcon } from "./field-icon";
import { FieldTypeMenu } from "./FieldTypeMenu";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

/** 新行默认名去重：统一叫「字段/字段 2/字段 3…」，避免同屏同名歧义 */
function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** 行详情属性区：可编辑该行的全部字段值，样式对齐 AppFlowy（图标 + 字段名 + 值） */
function RowPropertyField({
  field,
  row,
  primary = false,
}: {
  field: DatabaseField;
  row: DatabaseRow;
  primary?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(field.name);
  // 原子 selector：只订阅本行本字段值，其他行/字段变化不触发本组件重渲
  // 公式字段无存储值：按整行字段实时计算（结果为数字，引用稳定）
  const value = useDatabaseStore((s) =>
    field.field_type === "formula"
      ? computeFormula(field, s.cells[row.id] ?? {}, s.fields)
      : (s.cells[row.id]?.[field.id] ?? null),
  );
  const setCell = useDatabaseStore((s) => s.setCell);
  const addSelectOption = useDatabaseStore((s) => s.addSelectOption);
  const removeSelectOption = useDatabaseStore((s) => s.removeSelectOption);
  const changeFieldType = useDatabaseStore((s) => s.changeFieldType);
  const renameField = useDatabaseStore((s) => s.renameField);

  const commit = (v: CellValue) => {
    setEditing(false);
    void setCell(row.id, field.id, v);
  };

  const commitName = () => {
    setNameEditing(false);
    const next = nameDraft.trim();
    if (!next || next === field.name) return;
    void renameField(field.id, next).catch((e: unknown) => {
      logger.error("rename field failed", e);
      toast.error(t("error.db", { message: String(e) }));
    });
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
      {primary ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400">
          {fieldIcon(field.field_type)}
        </span>
      ) : (
        <FieldTypeMenu
          testid="row-field-icon"
          types={FIELD_TYPES}
          current={field.field_type}
          onSelect={(type) =>
            void changeFieldType(field.id, type as FieldType).catch((e: unknown) => {
              logger.error("change field type failed", e);
              toast.error(t("error.db", { message: String(e) }));
            })
          }
        />
      )}
      {nameEditing ? (
        <input
          autoFocus
          data-testid="row-field-name-input"
          className="h-5 w-20 shrink-0 rounded border border-neutral-300 px-1 text-[12px] outline-none focus:border-brand-400"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setNameDraft(field.name);
              setNameEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          data-testid="row-field-name"
          title={t("field.rename")}
          className="w-20 shrink-0 truncate text-left text-neutral-600 hover:text-neutral-800"
          onClick={() => {
            setNameDraft(field.name);
            setNameEditing(true);
          }}
        >
          {field.name}
        </button>
      )}
      <div
        className="relative min-w-0 flex-1 cursor-text rounded px-1.5 py-0.5 hover:bg-neutral-100"
        onClick={() => !isReadonlyType(field.field_type) && setEditing(true)}
      >
        {editing ? (
          <CellEditorSlot
            field={field}
            value={value}
            onCommit={commit}
            onCancel={() => setEditing(false)}
            onAddOption={(name) => {
              void addSelectOption(field.id, name);
              return null;
            }}
            onDeleteOption={(optId) => void removeSelectOption(field.id, optId)}
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
  const fields = useDatabaseStore((s) => s.fields);
  const addField = useDatabaseStore((s) => s.addField);
  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  // 放大态：居中大尺寸面板（配合头部放大/缩小按钮切换）
  const [enlarged, setEnlarged] = useState(false);

  const addTextField = async () => {
    const name = uniqueName(
      t("field.defaultName"),
      fields.map((f) => f.name),
    );
    try {
      await addField("text", name);
    } catch (e: unknown) {
      logger.error("add field failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // 普通态：右侧 400px 滑入；放大态：编辑区中央大尺寸（不超出编辑区，锚定到各视图根容器的 relative）
  const panelClass = enlarged
    ? "absolute left-1/2 top-1/2 h-[calc(100%-2rem)] w-[min(calc(100%-2rem),1100px)] -translate-x-1/2 -translate-y-1/2 " +
      "rounded-lg border border-neutral-200 shadow-2xl " +
      "animate-in fade-in zoom-in duration-200 ease-out " +
      "dark:border-neutral-700"
    : "absolute right-0 top-0 h-full w-[min(400px,100%)] " +
      "border-l border-neutral-200 shadow-2xl " +
      "animate-in slide-in-from-right duration-300 ease-out " +
      "dark:border-neutral-700";

  return (
    <div className="absolute inset-0 z-50">
      {/* 遮罩：覆盖编辑区（锚定到视图根容器的 relative），淡入动画（说明书 6.1：半透明黑） */}
      <div className="absolute inset-0 animate-in fade-in bg-black/20 duration-200" onClick={onClose} />
      {/* 面板：默认右侧滑入，放大态编辑区中央大尺寸 */}
      <div className={"flex flex-col bg-white " + panelClass}>
        {/* 顶部：行名 + 放大/关闭 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-700">
          <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-neutral-900">{view.name}</span>
          <button
            data-testid="enlarge-row-detail"
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200"
            title={enlarged ? t("rowDetail.shrink") : t("rowDetail.enlarge")}
            onClick={() => setEnlarged((v) => !v)}
          >
            {enlarged ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
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
            <RowPropertyField key={f.id} field={f} row={row} primary={f.id === visibleFields[0]?.id} />
          ))}
          <button
            data-testid="add-row-field"
            className="flex items-center gap-1.5 px-3 py-1 text-[12px] text-neutral-500 hover:text-neutral-800"
            onClick={() => void addTextField()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("field.addColumn")}
          </button>
        </div>
        {/* 正文文档：行详情不需要"添加属性"区（属性已在面板顶部编辑） */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* key 与 App.tsx 主编辑区一致：换行文档时必须新建编辑器实例，
              EditorPage 的加载效应只在 editor 为空时 setContent，复用实例会拒绝加载新文档 */}
          <EditorPage key={view.id} view={view} hideSlash />
        </div>
      </div>
    </div>
  );
}
