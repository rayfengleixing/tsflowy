// GridView 的单行渲染（从 GridView.tsx 原样搬出，无逻辑/样式改动）。
// 保持"普通函数直接调用"的形态（非组件），因此不引入组件边界、无 hooks，
// 行为与原内联 const renderRow 完全一致。
import type { RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CheckSquare,
  CornerDownRight,
  GripVertical,
  Indent,
  MoreHorizontal,
  Outdent,
  Square,
  Trash2,
} from "lucide-react";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import type { DatabaseState } from "@/stores/database";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MAX_HIERARCHY_LEVEL } from "@/lib/database-hierarchy";
import type { RowDropMode } from "./grid-view-model";
import { ROW_FOCUS_CLASS } from "./rowFocus";
import { CellDisplay } from "./grid-parts";
import { CellEditorSlot } from "./editors";
import { COND_TONE_CELL, toneOfIndex, type CondTone } from "@/lib/database-cond-format";

export interface GridRowContext {
  store: DatabaseState;
  source: View;
  visibleFields: DatabaseField[];
  primaryField: DatabaseField | null;
  editing: { rowId: string; fieldId: string } | null;
  /** 有效单元格展示图：公式/汇总/反向关系已按行求值一次（见 computeEvaluatedCells 的 display） */
  cells: Record<string, Record<string, CellValue>>;
  checkedRows: Set<string>;
  focusRowId: string | null;
  draggingRow: string | null;
  setDraggingRow: (id: string | null) => void;
  onRowDrop: (targetId: string, mode: RowDropMode) => void;
  /** 当前被拖的行能挂到哪些行下面（合法父行）；按住 Alt 悬停在这些行上才给嵌套提示 */
  nestCandidates: ReadonlySet<string>;
  /** 正在提示「松手就挂到这里」的行 */
  nestHintRowId: string | null;
  setNestHint: (rowId: string | null) => void;
  toggleRowChecked: (rowId: string) => void;
  setDeleteRowTarget: (row: DatabaseRow) => void;
  /** 在本行下新建子行（超深由 Rust 侧拒绝并提示） */
  onAddChildRow: (row: DatabaseRow) => void;
  /** 打开选父行弹窗改挂到别的行下 */
  onPickParent: (row: DatabaseRow) => void;
  /** 摘掉父级，升为顶层行 */
  onDetachParent: (row: DatabaseRow) => void;
  /** 行在整棵树里的层深（顶层为 1）：与 hier 的显示层深不同，分组视图下也准确 */
  rowDepthOf: (rowId: string) => number;
  commitCell: (rowId: string, fieldId: string, value: CellValue) => Promise<void>;
  setCursor: (c: { rowId: string; fieldId: string } | null) => void;
  setEditing: (c: { rowId: string; fieldId: string } | null) => void;
  pasteAnchorRef: RefObject<{ rowId: string; fieldId: string } | null>;
  /** 条件格式命中索引（行 id + 列 id → 颜色）；空 Map 即没有规则 */
  condToneIndex: Map<string, CondTone>;
}

/** 父子行层级下这一行的展示信息（未分组且本表有层级时才有；缺省即按普通行渲染） */
export interface GridRowHierarchy {
  /** 1 = 顶层 */
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
}

/** 行操作菜单：层级挂接的三个动作都收在这里，序号列窄到放不下第二个按钮 */
function GridRowMenu({ row, ctx }: { row: DatabaseRow; ctx: GridRowContext }) {
  const hasParent = row.parent_id != null;
  // 层深取全量行的真实深度：分组视图下 hier 不带深度，这里仍要挡住超深的新建子行
  const depth = ctx.rowDepthOf(row.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="row-menu"
          title={t("row.menu")}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-700"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem disabled={depth >= MAX_HIERARCHY_LEVEL} onSelect={() => ctx.onAddChildRow(row)}>
          <CornerDownRight className="mr-2 h-3.5 w-3.5" />
          {t("row.addChild")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => ctx.onPickParent(row)}>
          <Indent className="mr-2 h-3.5 w-3.5" />
          {t("row.setParent")}
        </DropdownMenuItem>
        {hasParent && (
          <DropdownMenuItem onSelect={() => ctx.onDetachParent(row)}>
            <Outdent className="mr-2 h-3.5 w-3.5" />
            {t("row.detachParent")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => ctx.setDeleteRowTarget(row)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("row.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 每层缩进宽度，与分组标题行的层级缩进同一口径 */
const HIER_INDENT_PX = 14;

export function renderGridRow(row: DatabaseRow, ctx: GridRowContext, hier?: GridRowHierarchy) {
  const {
    store,
    source,
    visibleFields,
    primaryField,
    editing,
    cells,
    checkedRows,
    focusRowId,
    draggingRow,
    setDraggingRow,
    onRowDrop,
    nestCandidates,
    nestHintRowId,
    setNestHint,
    toggleRowChecked,
    setDeleteRowTarget,
    commitCell,
    setCursor,
    setEditing,
    pasteAnchorRef,
    condToneIndex,
  } = ctx;
  // 整行规则命中的颜色：序号列与所有数据列共用
  const rowTone = toneOfIndex(condToneIndex, row.id, "");
  // 按住 Alt 拖到这一行上：提示「松手就挂成它的子行」（只有合法父行才给提示）
  const nestHint = nestHintRowId === row.id;
  const nestHintClass = nestHint && "bg-brand-50 dark:bg-brand-500/10";
  return (
    <tr
      key={row.id}
      data-row-id={row.id}
      draggable
      onDragStart={() => setDraggingRow(row.id)}
      onDragEnd={() => {
        setDraggingRow(null);
        setNestHint(null);
      }}
      onDragOver={(e) => {
        if (!draggingRow || draggingRow === row.id) return;
        e.preventDefault();
        setNestHint(e.altKey && nestCandidates.has(row.id) ? row.id : null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onRowDrop(row.id, e.altKey && nestCandidates.has(row.id) ? "nest" : "move");
      }}
      className={cn(
        "group/row hover:bg-neutral-100 dark:hover:bg-neutral-800/60",
        draggingRow === row.id && "opacity-40",
        checkedRows.has(row.id) && "bg-brand-50/70 dark:bg-brand-500/10",
        focusRowId === row.id && ROW_FOCUS_CLASS,
        nestHintClass,
      )}
    >
      <td
        className={cn(
          "sticky left-0 z-[5] border-b border-r border-neutral-200 bg-white px-2 text-center text-[11px] text-neutral-400 group-hover/row:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500 dark:group-hover/row:bg-neutral-800/60",
          rowTone && COND_TONE_CELL[rowTone],
          nestHintClass,
        )}
      >
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
        // cells 传入的已是"有效单元格"展示图（公式/汇总/反向关系已按行求值一次），这里直读不再逐格重算
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
        const value = cells[row.id]?.[field.id] ?? null;
        // 单元格规则优先，没命中再回落到整行规则
        const tone = toneOfIndex(condToneIndex, row.id, field.id);
        const cellBody = isEditing ? (
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
        );
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
              // 放在最后：tone 的背景类要盖过上面的 bg-white（含冻结列）
              !!tone && COND_TONE_CELL[tone],
              isPrimary && nestHintClass,
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
            {hier && isPrimary ? (
              <div className="flex h-full min-w-0 items-center">
                <span className="shrink-0" style={{ width: (hier.depth - 1) * HIER_INDENT_PX }} />
                {hier.hasChildren ? (
                  <button
                    type="button"
                    data-testid="toggle-row-children"
                    className="mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                    title={t(hier.collapsed ? "row.expandChildren" : "row.collapseChildren")}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      hier.onToggle();
                    }}
                  >
                    {hier.collapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                ) : (
                  // 叶子行留同宽占位，否则主列文字会随层级左右跳动
                  <span className="mr-0.5 h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">{cellBody}</div>
              </div>
            ) : (
              cellBody
            )}
            {isPrimary && !isEditing && (
              // 行操作菜单压在名称列右端（序号列已放满，第二个悬停按钮没地方摆）
              <div className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 group-hover/row:flex">
                <GridRowMenu row={row} ctx={ctx} />
              </div>
            )}
          </td>
        );
      })}
      <td className="border-b border-neutral-200 dark:border-neutral-700" />
    </tr>
  );
}
