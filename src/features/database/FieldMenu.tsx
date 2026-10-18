import { useState } from "react";
import { Eye, EyeOff, Pencil, Settings2, Trash2 } from "lucide-react";
import type { FieldType } from "@/types/database";
import { FIELD_TYPES } from "@/types/database";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";

/** 字段菜单（说明书 10-M4：重命名/改类型/隐藏/删除/选项设置） */
export function FieldMenu(props: {
  fieldName: string;
  fieldType: FieldType;
  hidden: boolean;
  /** 名称列（主列）：不可改类型/隐藏/删除 */
  primary?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  onChangeType: (type: FieldType) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
  onOpenOptions: () => void;
}) {
  const {
    fieldName,
    fieldType,
    hidden,
    primary = false,
    open,
    onOpenChange,
    onRename,
    onChangeType,
    onToggleHidden,
    onDelete,
    onOpenOptions,
  } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 改类型会清空整列单元格值（后端语义），必须先确认——旧版本直接落库、不可撤销
  const [pendingType, setPendingType] = useState<FieldType | null>(null);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            data-testid="field-menu"
            aria-label={t("field.menu")}
            className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-300/70 hover:text-neutral-600"
            onClick={(e) => e.stopPropagation()}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="truncate pr-6">{fieldName}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("field.rename")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={primary}>{t("field.changeType")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
              {FIELD_TYPES.map((type) => (
                <DropdownMenuItem
                  key={type}
                  disabled={type === fieldType}
                  onSelect={() => setPendingType(type)}
                  data-active={type === fieldType}
                >
                  <span
                    className={"mr-2 h-2 w-2 rounded-full " + (type === fieldType ? "bg-brand-500" : "bg-neutral-300")}
                  />
                  {t(`field.type.${type}` as never)}
                  {type === fieldType && <span className="ml-2 text-[11px] text-neutral-400">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onOpenOptions}>
            <Settings2 className="mr-2 h-3.5 w-3.5" />
            {t("field.options")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleHidden} disabled={primary}>
            {hidden ? <Eye className="mr-2 h-3.5 w-3.5" /> : <EyeOff className="mr-2 h-3.5 w-3.5" />}
            {hidden ? t("field.show") : t("field.hide")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={primary} onSelect={() => setConfirmDelete(true)}>
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("field.confirmDeleteTitle")}
        description={t("field.confirmDeleteDesc", { name: fieldName })}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
      />
      <ConfirmDialog
        open={pendingType !== null}
        onOpenChange={(v) => !v && setPendingType(null)}
        title={t("field.confirmChangeTypeTitle")}
        description={t("field.confirmChangeTypeDesc", {
          name: fieldName,
          from: t(`field.type.${fieldType}` as never),
          to: pendingType ? t(`field.type.${pendingType}` as never) : "",
        })}
        confirmLabel={t("field.changeType")}
        onConfirm={() => {
          const next = pendingType;
          setPendingType(null);
          if (next) onChangeType(next);
        }}
      />
    </>
  );
}
