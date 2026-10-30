import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CheckSquare, Pencil, Square } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDbStore } from "@/stores/database-context";
import { BulkEditDialog } from "./BulkEditDialog";
import { cellAt } from "@/lib/database/database-query";
import { t } from "@/lib/i18n";
import type { BulkUpdate } from "@/lib/database/database-bulk-edit";

/** 选中态的可视反馈：不做常驻选区条，只在被选中的那一项上贴一圈 */
export const ROW_SELECTED_RING = "z-10 ring-1 ring-inset ring-brand-500";

/**
 * 非表格视图的「右键选 + 临时多选」。
 * 表格视图有勾选列，这里没有：选择态只活在当前这一屏，切视图（组件重挂载）就清空，所以叫临时。
 * 目标行沿用表格视图的口径——选中集合投影到当前可见行，被筛掉的行不会跟着改。
 */
export function useRowBulkEdit(visibleRowIds: string[]) {
  const store = useDbStore();
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const selectedIds = useMemo(() => visibleRowIds.filter((id) => checked.has(id)), [visibleRowIds, checked]);
  // 连点同一行不能都基于同一份旧集合，所以走回调形式
  const toggle = useCallback((rowId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);
  const clear = useCallback(() => setChecked((prev) => (prev.size === 0 ? prev : new Set())), []);
  const isSelected = useCallback((rowId: string) => checked.has(rowId), [checked]);

  // 批量改值读的是存储值（不是计算列的展示值）：cells 为按行稀疏映射，没写过的格子按空值算
  const readCell = useCallback((rowId: string, fieldId: string) => cellAt(store.cells, rowId, fieldId), [store.cells]);
  const apply = useCallback(
    async (updates: BulkUpdate[]) => {
      await store.setCellsMany(updates);
      // 改完清掉选择，避免「刚改的行还挂着选」让人以为没生效
      clear();
    },
    [store, clear],
  );

  return { selectedIds, isSelected, toggle, clear, bulkOpen, setBulkOpen, readCell, apply };
}

export type RowBulkEdit = ReturnType<typeof useRowBulkEdit>;

/**
 * 一行 / 一张卡 / 一个日格的右键菜单：未选中给「选择」，选中后给「取消选择」加「批量修改」。
 * 「批量修改」只挂在选中项上，是因为多选本来就是就地发起的——没选中的那一项上没有别人的一把。
 * children 必须是单个能挂 ref 的节点（Radix 的 asChild 把事件合到它身上）。
 */
export function RowSelectMenu({ bulk, rowId, children }: { bulk: RowBulkEdit; rowId: string; children: ReactNode }) {
  const selected = bulk.isSelected(rowId);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem data-testid={"row-ctx-toggle-" + rowId} onSelect={() => bulk.toggle(rowId)}>
          {selected ? <CheckSquare className="h-3.5 w-3.5 text-brand-500" /> : <Square className="h-3.5 w-3.5" />}
          {t(selected ? "row.deselect" : "row.select")}
        </ContextMenuItem>
        {/* 菜单渲染在本视图的可见行里，所以 selected 已蕴含 selectedIds 非空，不必再判一次 */}
        {selected && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem data-testid="row-ctx-bulk-edit" onSelect={() => bulk.setBulkOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />
              {t("row.bulkEdit")}
              <span className="ml-auto rounded bg-brand-100 px-1.5 text-[11px] text-brand-600 dark:bg-brand-600/20 dark:text-brand-300">
                {bulk.selectedIds.length}
              </span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 批量改值弹窗宿主：挂在视图 JSX 末尾，与各视图的 CondFormatDialogHost 同一位置 */
export function BulkEditDialogHost({ bulk }: { bulk: RowBulkEdit }) {
  const fields = useDbStore((s) => s.fields);
  return (
    <BulkEditDialog
      open={bulk.bulkOpen}
      onOpenChange={bulk.setBulkOpen}
      fields={fields}
      rowIds={bulk.selectedIds}
      readCell={bulk.readCell}
      onApply={bulk.apply}
    />
  );
}
