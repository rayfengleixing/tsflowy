import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { CellValue, DatabaseField } from "@/types/database";
import { aggregateValue, type AggregateFn } from "@/lib/database-aggregate";
import { t } from "@/lib/i18n";

// GridView 表格里自包含的"行级"展示：占位行 / 分组标题行 / 分组小计行 / 新建行。
// 从 GridView.tsx 原样搬出（无逻辑/样式改动），props 即所需状态，零闭包耦合。

/** 窗口化占位行：窗口外的行用一条空行撑住高度（列宽由 colgroup 决定，占位不参与渲染） */
export function GridSpacerRow({ height, colSpan }: { height: number; colSpan: number }) {
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={colSpan} className="border-0 p-0" />
    </tr>
  );
}

/** 分组标题行：折叠开关 + 组名 + 行数 */
export function GridGroupHeaderRow({
  label,
  count,
  collapsed,
  onToggle,
  colSpan,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  colSpan: number;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="border-b border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900/40"
      >
        <button
          className="flex items-center gap-1.5 text-[12px] font-medium text-neutral-700 dark:text-neutral-200"
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
          <span className="text-[11px] font-normal text-neutral-400">{count}</span>
        </button>
      </td>
    </tr>
  );
}

/** 分组小计行：只铺已配置汇总的列，其余列留空 */
export function GridSubtotalRow({
  rowIds,
  visibleFields,
  aggregateOf,
  cells,
}: {
  rowIds: string[];
  visibleFields: DatabaseField[];
  aggregateOf: (field: DatabaseField) => AggregateFn | undefined;
  cells: Record<string, Record<string, CellValue>>;
}) {
  return (
    <tr className="bg-neutral-50/80 dark:bg-neutral-900/40">
      <td className="border-b border-r border-neutral-200 px-1 text-right text-[11px] text-neutral-400 dark:border-neutral-700">
        {t("grid.subtotal")}
      </td>
      {visibleFields.map((field) => {
        const fn = aggregateOf(field);
        return (
          <td
            key={field.id}
            className="h-7 border-b border-r border-neutral-200 px-2 align-middle text-[11px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
          >
            {fn ? aggregateValue(fn, field, rowIds, cells) : null}
          </td>
        );
      })}
      <td className="border-b border-neutral-200 dark:border-neutral-700" />
    </tr>
  );
}

/** 新建行：跨整行底部，避免无字段时挤在窄列里 */
export function GridAddRow({ colSpan, onAdd }: { colSpan: number; onAdd: () => void }) {
  return (
    <tr>
      <td colSpan={colSpan} className="h-8 border-t border-neutral-200 px-2 dark:border-neutral-700">
        <button
          data-testid="add-row"
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("row.new")}
        </button>
      </td>
    </tr>
  );
}
