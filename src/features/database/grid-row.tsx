// GridView 的单行渲染（从 GridView.tsx 原样搬出，无逻辑/样式改动）。
// 保持"普通函数直接调用"的形态（非组件），因此不引入组件边界、无 hooks，
// 行为与原内联 const renderRow 完全一致。
import type { RefObject } from "react";
import { ExternalLink, CheckSquare, GripVertical, Square, Trash2 } from "lucide-react";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import type { DatabaseState } from "@/stores/database";
import { computeFormula } from "@/lib/database-formula";
import { computeReverseRelation, computeRollup, type RelationDb } from "@/lib/relation";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { ROW_FOCUS_CLASS } from "./rowFocus";
import { CellDisplay } from "./grid-parts";
import { CellEditorSlot } from "./editors";

export interface GridRowContext {
  store: DatabaseState;
  source: View;
  visibleFields: DatabaseField[];
  primaryField: DatabaseField | null;
  editing: { rowId: string; fieldId: string } | null;
  cells: Record<string, Record<string, CellValue>>;
  fields: DatabaseField[];
  relationDbOf: (viewId: string) => RelationDb | undefined;
  checkedRows: Set<string>;
  focusRowId: string | null;
  draggingRow: string | null;
  setDraggingRow: (id: string | null) => void;
  onRowDrop: (targetId: string) => void;
  toggleRowChecked: (rowId: string) => void;
  setDeleteRowTarget: (row: DatabaseRow) => void;
  commitCell: (rowId: string, fieldId: string, value: CellValue) => Promise<void>;
  setCursor: (c: { rowId: string; fieldId: string } | null) => void;
  setEditing: (c: { rowId: string; fieldId: string } | null) => void;
  pasteAnchorRef: RefObject<{ rowId: string; fieldId: string } | null>;
}

export function renderGridRow(row: DatabaseRow, ctx: GridRowContext) {
  const {
    store,
    source,
    visibleFields,
    primaryField,
    editing,
    cells,
    fields,
    relationDbOf,
    checkedRows,
    focusRowId,
    draggingRow,
    setDraggingRow,
    onRowDrop,
    toggleRowChecked,
    setDeleteRowTarget,
    commitCell,
    setCursor,
    setEditing,
    pasteAnchorRef,
  } = ctx;
  return (
    <tr
      key={row.id}
      data-row-id={row.id}
      draggable
      onDragStart={() => setDraggingRow(row.id)}
      onDragEnd={() => setDraggingRow(null)}
      onDragOver={(e) => {
        if (draggingRow && draggingRow !== row.id) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onRowDrop(row.id);
      }}
      className={cn(
        "group/row hover:bg-neutral-100 dark:hover:bg-neutral-800/60",
        draggingRow === row.id && "opacity-40",
        checkedRows.has(row.id) && "bg-brand-50/70 dark:bg-brand-500/10",
        focusRowId === row.id && ROW_FOCUS_CLASS,
      )}
    >
      <td className="sticky left-0 z-[5] border-b border-r border-neutral-200 bg-white px-2 text-center text-[11px] text-neutral-400 group-hover/row:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500 dark:group-hover/row:bg-neutral-800/60">
        <span className="flex items-center justify-center gap-1">
          {/* icon 区域固定 16px 宽：消除 GripVertical(12px) → Square/CheckSquare(16px) 的占位跳动 */}
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {checkedRows.has(row.id) ? (
              <button
                className="flex h-4 w-4 items-center justify-center rounded text-brand-600 hover:bg-brand-100 dark:hover:bg-brand-500/10"
                title={t("row.select")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRowChecked(row.id);
                }}
              >
                <CheckSquare className="h-3.5 w-3.5" />
              </button>
            ) : (
              <>
                <button
                  className="hidden h-4 w-4 items-center justify-center rounded text-neutral-300 hover:text-brand-600 group-hover/row:flex dark:text-neutral-600"
                  title={t("row.select")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRowChecked(row.id);
                  }}
                >
                  <Square className="h-3 w-3" />
                </button>
                <GripVertical className="h-3 w-3 cursor-grab text-neutral-200 group-hover/row:hidden dark:text-neutral-700" />
              </>
            )}
          </span>
          {/* 序号等宽数字 + 固定宽度：防止 1(窄) vs 0/2-9(宽) 及位数变化导致的列宽抖动 */}
          <span className="tabular-nums w-5 shrink-0 text-center">{row.position + 1}</span>
        </span>
        <button
          className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-100 hover:text-red-500 group-hover/row:flex dark:hover:bg-red-500/10"
          title={t("row.delete")}
          onClick={() => setDeleteRowTarget(row)}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </td>
      {visibleFields.map((field) => {
        const isPrimary = field.id === primaryField?.id;
        const isEditing = editing?.rowId === row.id && editing.fieldId === field.id;
        // 公式/汇总/反向关系字段无存储值：渲染时按表达式/关联行/来源行实时计算
        const value =
          field.field_type === "formula"
            ? computeFormula(field, cells[row.id] ?? {}, fields)
            : field.field_type === "rollup"
              ? computeRollup(field, cells[row.id] ?? {}, fields, relationDbOf)
              : field.field_type === "reverse_relation"
                ? computeReverseRelation(row.id, field, relationDbOf)
                : // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
                  (cells[row.id]?.[field.id] ?? null);
        return (
          <td
            key={field.id}
            data-cell-row={row.id}
            data-cell-field={field.id}
            tabIndex={-1}
            className={cn(
              "relative h-8 border-b border-r border-neutral-200 p-0 align-middle outline-none dark:border-neutral-700",
              isEditing && "z-10 ring-1 ring-inset ring-brand-500 dark:ring-brand-500",
              !isEditing && "focus:z-10 focus:ring-1 focus:ring-inset focus:ring-brand-500",
              // 冻结主列：跟随序号列（44px）右侧
              isPrimary && "sticky left-[44px] z-[5] bg-white dark:bg-neutral-900",
              isPrimary && "cursor-pointer",
            )}
            onClick={() => {
              if (isPrimary) {
                // 名称列：单击编辑值（编辑框后的"打开"图标/双击打开所属页面）
                setCursor({ rowId: row.id, fieldId: field.id });
                setEditing({ rowId: row.id, fieldId: field.id });
                pasteAnchorRef.current = { rowId: row.id, fieldId: field.id };
                return;
              }
              // TSV 粘贴锚点与键盘光标：任何可编辑格都记录
              if (!isReadonlyType(field.field_type)) pasteAnchorRef.current = { rowId: row.id, fieldId: field.id };
              if (isReadonlyType(field.field_type) || isEditing) return;
              setCursor({ rowId: row.id, fieldId: field.id });
              if (field.field_type === "checkbox") {
                // 复选框：单击直接切换勾选
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
                void commitCell(row.id, field.id, cells[row.id]?.[field.id] !== true);
                return;
              }
              setEditing({ rowId: row.id, fieldId: field.id });
            }}
          >
            {isEditing ? (
              <div className="flex h-full items-center pr-1">
                <div className="min-w-0 flex-1">
                  <CellEditorSlot
                    field={field}
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
                    value={cells[row.id]?.[field.id] ?? null}
                    onCommit={(v) => void commitCell(row.id, field.id, v)}
                    onCancel={() => setEditing(null)}
                    onAddOption={(name) => store.addSelectOption(field.id, name)}
                    onDeleteOption={(optId) => void store.removeSelectOption(field.id, optId)}
                  />
                </div>
                {isPrimary && (
                  <button
                    type="button"
                    className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-brand-600"
                    title={t("row.openDetail")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(null);
                      void store.openRowDetail(row, source);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <CellDisplay
                field={field}
                value={value}
                primary={isPrimary}
                onChipRemove={(newVal) => void store.setCell(row.id, field.id, newVal)}
                onOpenRowDetail={() => void store.openRowDetail(row, source)}
              />
            )}
          </td>
        );
      })}
      <td className="border-b border-neutral-200 dark:border-neutral-700" />
    </tr>
  );
}
