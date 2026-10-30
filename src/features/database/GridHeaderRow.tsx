// GridView 的表头行：原来在宿主里是一整段 <thead>，连同只服务它的三个状态（重命名进行中、
// 字段菜单开给谁、拖拽中的列）和三个动作（列宽拖拽、排序循环、字段拖落）一起切出来。
// 跨边界的两件事仍归宿主：勾了哪些行（全选按钮递 onToggleSelectAll）、字段设置弹层开给谁（onConfigure）；
// <table> 的 ref 也归宿主——列宽拖拽按 fieldId 找 <col> 改宽度，而 <colgroup> 在宿主里。
import { useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { CheckSquare, GripVertical, Square } from "lucide-react";
import { toast } from "sonner";
import type { DatabaseField } from "@/types/database";
import type { SortSpec } from "@/lib/database/database-query";
import { useDbStore, useDbStoreApi } from "@/stores/database-context";
import { FieldMenu } from "./FieldMenu";
import { AddFieldButton, RenameInput, needsFieldSettings } from "./grid-parts";
import { clampColumnWidth } from "./grid-view-helpers";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

interface GridHeaderRowProps {
  /** 可见字段（含主列，顺序即列顺序） */
  visibleFields: DatabaseField[];
  /** 主列：表头冻结在左侧，不可拖、不可删、不可改类型 */
  primaryField: DatabaseField | null;
  /** <table> 的 ref 归宿主：列宽拖拽直接改 <col> 的宽度 */
  tableRef: RefObject<HTMLTableElement | null>;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  /** 打开字段设置弹层（弹层本体在宿主；改完类型也要用它） */
  onConfigure: (field: DatabaseField) => void;
}

export function GridHeaderRow({
  visibleFields,
  primaryField,
  tableRef,
  allSelected,
  onToggleSelectAll,
  onConfigure,
}: GridHeaderRowProps) {
  const store = useDbStore();
  const storeApi = useDbStoreApi();
  const { fields, sorts } = store;
  const [renamingField, setRenamingField] = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [draggingField, setDraggingField] = useState<string | null>(null);

  // 列宽拖拽：拖拽期间直接改 <col> 宽度（纯 DOM，零重渲/零 IPC），mouseup 才落库一次
  const startColumnResize = (e: ReactMouseEvent, fieldId: string, startWidth: number) => {
    e.preventDefault();
    const col = tableRef.current?.querySelector<HTMLTableColElement>(`col[data-field-id="${fieldId}"]`);
    if (!col) return;
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      col.style.width = clampColumnWidth(startWidth + ev.clientX - startX) + "px";
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const width = clampColumnWidth(startWidth + ev.clientX - startX);
      void store.setFieldWidth(fieldId, width).catch((err: unknown) => {
        col.style.width = ""; // 落库失败：去掉本地预览宽度，回退 store 旧值
        logger.error("set field width failed", err);
        toast.error(t("error.db", { message: String(err) }));
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // 表头单击：没排过 → 追加升序；升序 → 转降序；降序 → 取消该字段（其余字段保持）
  const cycleSort = (fieldId: string) => {
    const current = sorts.find((s) => s.field_id === fieldId);
    const next: SortSpec[] = !current
      ? [...sorts, { field_id: fieldId, dir: "asc" }]
      : current.dir === "asc"
        ? sorts.map((s) => (s.field_id === fieldId ? { ...s, dir: "desc" as const } : s))
        : sorts.filter((s) => s.field_id !== fieldId);
    store.setSorts(next);
  };
  // 字段拖拽排序（主列固定首位，只在其它列之间排序）
  const onFieldDrop = (targetId: string) => {
    if (!draggingField || draggingField === targetId) return;
    if (draggingField === primaryField?.id || targetId === primaryField?.id) return;
    // 全量重排（含隐藏列）：传 visibleFields 会把隐藏字段从 store.fields 里剔除
    const sortable = fields.filter((f) => f.id !== primaryField?.id).map((f) => f.id);
    const from = sortable.indexOf(draggingField);
    const to = sortable.indexOf(targetId);
    if (from < 0 || to < 0) return;
    sortable.splice(to, 0, sortable.splice(from, 1)[0]);
    void store.reorderFields([primaryField?.id, ...sortable].filter((id): id is string => Boolean(id)));
    setDraggingField(null);
  };

  return (
    <thead>
      <tr>
        <th className="sticky left-0 z-[6] border-b border-r border-neutral-200 bg-neutral-100 px-2 text-[11px] font-normal text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
          <button
            className="mx-auto flex h-4 w-4 items-center justify-center rounded text-neutral-500 hover:text-brand-600 dark:text-neutral-400"
            title={t("row.selectAll")}
            aria-label={t("row.selectAll")}
            onClick={onToggleSelectAll}
          >
            {allSelected ? <CheckSquare className="h-3.5 w-3.5 text-brand-600" /> : <Square className="h-3 w-3" />}
          </button>
        </th>
        {visibleFields.map((field) => {
          const sortIndex = sorts.findIndex((s) => s.field_id === field.id);
          const sort = sortIndex === -1 ? null : sorts[sortIndex];
          const isPrimary = field.id === primaryField?.id;
          return (
            <th
              key={field.id}
              className={cn(
                "group/head relative border-b border-r border-neutral-200 bg-neutral-100 px-1 dark:border-neutral-700 dark:bg-neutral-800",
                // 冻结主列表头：z 高于正文 sticky 列
                isPrimary && "sticky left-[44px] z-[6]",
              )}
            >
              <div
                draggable={field.id !== primaryField?.id}
                onDragStart={() => {
                  if (field.id !== primaryField?.id) setDraggingField(field.id);
                }}
                onDragEnd={() => setDraggingField(null)}
                onDragOver={(e) => {
                  if (draggingField && draggingField !== field.id && field.id !== primaryField?.id) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onFieldDrop(field.id);
                }}
                className={cn("flex h-8 cursor-pointer items-center gap-1", draggingField === field.id && "opacity-40")}
                onClick={() => cycleSort(field.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenFor(field.id);
                }}
              >
                <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-neutral-300 dark:text-neutral-600" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-100">
                  {field.name}
                </span>
                <span className="flex h-4 min-w-4 shrink-0 items-center justify-center gap-0.5 text-[10px] text-brand-600 dark:text-brand-500">
                  {sort && (
                    <>
                      <span>{sort.dir === "asc" ? "↑" : "↓"}</span>
                      {sorts.length > 1 && (
                        <span className="text-[9px] text-neutral-400 dark:text-neutral-500">{sortIndex + 1}</span>
                      )}
                    </>
                  )}
                </span>
                <FieldMenu
                  fieldName={field.name}
                  fieldType={field.field_type}
                  hidden={field.is_hidden === 1}
                  primary={field.id === primaryField?.id}
                  open={menuOpenFor === field.id}
                  onOpenChange={(open) => {
                    setMenuOpenFor(open ? field.id : null);
                  }}
                  onRename={() => {
                    setMenuOpenFor(null);
                    setRenamingField(field.id);
                  }}
                  onChangeType={(type) => {
                    setMenuOpenFor(null);
                    void store.changeFieldType(field.id, type).then(() => {
                      // 改成关联/公式/汇总后必须配置才有意义，直接弹出字段设置
                      if (!needsFieldSettings(type)) return;
                      const next = storeApi.getState().fields.find((f) => f.id === field.id);
                      if (next) onConfigure(next);
                    });
                  }}
                  onToggleHidden={() => {
                    setMenuOpenFor(null);
                    void store.toggleFieldHidden(field.id);
                  }}
                  onDelete={() => {
                    setMenuOpenFor(null);
                    void store.removeField(field.id);
                  }}
                  onOpenOptions={() => {
                    setMenuOpenFor(null);
                    onConfigure(field);
                  }}
                />
              </div>
              {/* 重命名输入 */}
              {renamingField === field.id && (
                <RenameInput
                  initial={field.name}
                  onCommit={(name) => {
                    setRenamingField(null);
                    if (name && name !== field.name) void store.renameField(field.id, name);
                  }}
                  onCancel={() => setRenamingField(null)}
                />
              )}
              {/* 列宽拖拽手柄 */}
              <div
                data-testid={"resize-" + field.id}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("grid.resizeColumn")}
                className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-brand-500/60"
                onMouseDown={(e) => startColumnResize(e, field.id, field.width)}
              />
            </th>
          );
        })}
        <th className="border-b border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
          <AddFieldButton onConfigure={onConfigure} />
        </th>
      </tr>
    </thead>
  );
}
