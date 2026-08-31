import { useState, type ReactNode } from "react";
import {
  Calendar,
  CheckSquare,
  CircleDot,
  Clock,
  Hash,
  History,
  Link2,
  ListChecks,
  Mail,
  Phone,
  Plus,
  Type as TypeIcon,
  Link as LinkIcon,
  X,
} from "lucide-react";
import type { CellValue, DatabaseField, DatabaseRow, FieldType, SelectOption } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import { useDatabaseStore } from "@/stores/database";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { cn } from "@/lib/utils";
import type { View } from "@/types/models";
import { EditorPage } from "@/features/editor/EditorPage";
import { CellEditorSlot } from "./editors";
import { NewFieldDialog } from "./NewFieldDialog";
import { t } from "@/lib/i18n";

/** 字段类型 → 图标（对齐 AppFlowy 行详情的属性图标） */
function fieldIcon(type: FieldType): ReactNode {
  const cls = "h-3.5 w-3.5 shrink-0 text-neutral-400";
  switch (type) {
    case "text": return <TypeIcon className={cls} />;
    case "number": return <Hash className={cls} />;
    case "date": return <Calendar className={cls} />;
    case "single_select": return <CircleDot className={cls} />;
    case "multi_select": return <ListChecks className={cls} />;
    case "checkbox": return <CheckSquare className={cls} />;
    case "url": return <LinkIcon className={cls} />;
    case "phone": return <Phone className={cls} />;
    case "email": return <Mail className={cls} />;
    case "relation": return <Link2 className={cls} />;
    case "created_at": return <Clock className={cls} />;
    case "last_edited_at": return <History className={cls} />;
  }
}

const CHIP_COLORS: Record<string, string> = {
  blue: "bg-brand-100 text-brand-600",
  green: "bg-green-100 text-green-700",
  orange: "bg-orange-100 text-orange-700",
  purple: "bg-purple-100 text-purple-700",
  red: "bg-red-100 text-red-700",
  yellow: "bg-yellow-100 text-yellow-700",
  gray: "bg-neutral-200 text-neutral-600",
};

/** 单选/多选值的彩色胶囊展示 */
function SelectChips({ field, value }: { field: DatabaseField; value: CellValue }) {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "select") return null;
  if (field.field_type === "single_select") {
    if (typeof value !== "string") return null;
    const o = opts.options.find((x) => x.id === value);
    return <Chip option={o} />;
  }
  const ids = Array.isArray(value) ? value : [];
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const o = opts.options.find((x) => x.id === id);
        return <Chip key={id} option={o} />;
      })}
    </span>
  );
}

function Chip({ option }: { option?: SelectOption }) {
  if (!option) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", CHIP_COLORS[option.color] ?? "bg-neutral-200 text-neutral-600")}>
      {option.name}
    </span>
  );
}

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
      <span className={cn(isReadonlyType(field.field_type) ? "text-neutral-400" : value !== null ? "text-neutral-800" : "text-neutral-300")}>
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
          />
        ) : (
          display
        )}
      </div>
    </div>
  );
}

/** 行详情弹窗（居中大弹窗，样式对齐 AppFlowy：行名 + 属性区 + 正文），复用 M3 编辑器 */
export function RowDetailPanel({ row, view, onClose }: { row: DatabaseRow; view: View; onClose: () => void }) {
  const store = useDatabaseStore();
  const visibleFields = store.fields.filter((f) => f.is_hidden === 0);
  const [newFieldOpen, setNewFieldOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative flex h-[min(88vh,760px)] w-[min(860px,94vw)] flex-col rounded-xl bg-white shadow-2xl">
        {/* 顶部：行名 + 关闭 */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-5">
          <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-neutral-900">
            {view.name}
          </span>
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
          <EditorPage view={view} hideTitle />
        </div>
      </div>
      <NewFieldDialog open={newFieldOpen} onOpenChange={setNewFieldOpen} onCreate={async (name, type) => {
        try {
          await store.addField(type, name);
          setNewFieldOpen(false);
        } catch (e) {
          console.error("add field failed", e);
        }
      }} />
    </div>
  );
}