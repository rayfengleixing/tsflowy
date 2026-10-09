import { useState } from "react";
import { ExternalLink, Eye, EyeOff, Plus } from "lucide-react";
import { toast } from "sonner";
import type { CellValue, DatabaseField } from "@/types/database";
import { isReadonlyType, type FieldType } from "@/types/database";
import { useDbStore } from "@/stores/database-context";
import { formatCellValue, parseFieldOptions, ratingMax } from "@/lib/database-values";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { NewFieldDialog } from "./NewFieldDialog";
import { AttachmentChips, ProgressCell, RatingCell, RelationChips, ReverseRelationChips, SelectChips } from "./editors";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function RenameInput(props: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <input
      autoFocus
      className="absolute inset-x-1 top-1/2 h-6 -translate-y-1/2 rounded border border-brand-500 bg-white px-1.5 text-[12px] outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onCommit(draft);
        if (e.key === "Escape") props.onCancel();
      }}
      onBlur={() => props.onCommit(draft)}
    />
  );
}

/** 隐藏列恢复入口：FieldMenu 只挂在可见列头上，列一旦隐藏就再没有打开的入口，
 *  这里按"点对象本身"的方式列出来，点一下即恢复该列。 */
export function HiddenColumnsMenu({ fields, onShow }: { fields: DatabaseField[]; onShow: (id: string) => void }) {
  const hidden = fields.filter((f) => f.is_hidden === 1);
  if (hidden.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title={t("field.hiddenColumns")}>
          <EyeOff className="h-3.5 w-3.5" />
          {t("field.hiddenColumns")}
          <span className="ml-1 rounded-full bg-neutral-200 px-1.5 text-[10px] text-neutral-600">{hidden.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>{t("field.hiddenColumns")}</DropdownMenuLabel>
        {hidden.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onShow(f.id)}>
            <Eye className="mr-2 h-3.5 w-3.5" />
            <span className="truncate">{f.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 需要额外配置才有意义的字段类型：关联要选目标表，公式要写表达式，汇总要选关联/目标/聚合，
 *  反向关系要选来源表与其指向本表的关联字段 */
export function needsFieldSettings(type: FieldType): boolean {
  return type === "relation" || type === "formula" || type === "rollup" || type === "reverse_relation";
}

export function AddFieldButton(props: { onConfigure: (field: DatabaseField) => void }) {
  const { onConfigure } = props;
  const store = useDbStore();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        data-testid="add-field"
        className="flex h-8 w-8 items-center justify-center text-neutral-500 hover:bg-neutral-300/50"
        title={t("field.new")}
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" />
      </button>
      <NewFieldDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (name, type) => {
          try {
            const field = await store.addField(type, name);
            setOpen(false);
            // 关联/公式/汇总建好后必须配置才有意义，直接弹出字段设置
            if (field && needsFieldSettings(field.field_type)) onConfigure(field);
          } catch (e) {
            logger.error("add field failed", e);
            toast.error(t("error.db", { message: String(e) }));
          }
        }}
      />
    </>
  );
}

/** 单元格显示（非编辑态） */
export function CellDisplay({
  field,
  value,
  primary = false,
  onChipRemove,
  onOpenRowDetail,
}: {
  field: DatabaseField;
  value: CellValue;
  primary?: boolean;
  onChipRemove?: (newValue: CellValue) => void;
  onOpenRowDetail?: () => void;
}) {
  const opts = parseFieldOptions(field.options);
  if (field.field_type === "checkbox") {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-brand-600">
        {value === true ? "✓" : ""}
      </div>
    );
  }
  // 进度列：整格进度条 + 百分比
  if (field.field_type === "progress") {
    return (
      <div className="flex h-full w-full items-center px-2">
        <ProgressCell value={value} />
      </div>
    );
  }
  // 评分列：星级
  if (field.field_type === "rating") {
    return (
      <div className="flex h-full w-full items-center px-2">
        <RatingCell value={value} max={ratingMax(opts)} />
      </div>
    );
  }
  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    return (
      <div className="flex h-full w-full items-center truncate px-2">
        {Array.isArray(value) && value.length === 0 ? (
          <span className="text-neutral-300" />
        ) : (
          <SelectChips field={field} value={value} onRemove={onChipRemove} />
        )}
      </div>
    );
  }
  if (field.field_type === "relation") {
    return (
      <div className="flex h-full w-full items-center truncate px-2">
        {Array.isArray(value) && value.length === 0 ? (
          <span className="text-neutral-300" />
        ) : (
          <RelationChips field={field} value={value} />
        )}
      </div>
    );
  }
  // 反向关系只读虚拟列：value 由调用方实时反查（来源行 id 数组），这里解析成来源行标题
  if (field.field_type === "reverse_relation") {
    return (
      <div className="flex h-full w-full items-center truncate px-2">
        {Array.isArray(value) && value.length > 0 ? (
          <ReverseRelationChips field={field} value={value} />
        ) : (
          <span className="text-neutral-300" />
        )}
      </div>
    );
  }
  // 附件列：value 为 [{name,path}] 数组，用可点击的胶囊展示文件名
  if (field.field_type === "attachment") {
    return (
      <div className="flex h-full w-full items-center truncate px-2">
        {Array.isArray(value) && value.length > 0 ? (
          <AttachmentChips value={value} />
        ) : (
          <span className="text-neutral-300" />
        )}
      </div>
    );
  }
  const text = formatCellValue(field.field_type, value, opts);
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-1 truncate px-2 text-[13px] leading-8",
        isReadonlyType(field.field_type) && "text-neutral-400",
        primary && "font-medium text-neutral-900",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {primary && onOpenRowDetail && (
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-brand-600"
          title={t("row.openDetail")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenRowDetail();
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
