import { useState } from "react";
import type { FieldType } from "@/types/database";
import { FIELD_TYPES } from "@/types/database";
/** 虚拟"附件"类型：创建时走 url + options 标记 attachment */
type DialogFieldType = FieldType | "attachment";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** 新建字段对话框（项目说明书 5.1：字段新增；输入名称 + 选择类型） */
export function NewFieldDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string | undefined, type: FieldType | "attachment") => Promise<void>;
}) {
  const { open, onOpenChange, onCreate } = props;
  const [name, setName] = useState("");
  const [type, setType] = useState<DialogFieldType>("text");
  const [saving, setSaving] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName("");
      setType("text");
    }
    onOpenChange(next);
  };

  const create = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (type === "attachment") {
        await onCreate(name.trim() || undefined, "attachment");
      } else {
        await onCreate(name.trim() || undefined, type);
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[380px]">
        <DialogHeader>
          <DialogTitle>{t("field.newTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
            {t("field.newFieldName")}
            <input
              autoFocus
              className="h-8 rounded-md border border-neutral-300 px-2 text-[13px] outline-none focus:border-brand-500"
              placeholder={t("field.newName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
                if (e.key === "Escape") onOpenChange(false);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-neutral-500">
            {t("field.newFieldType")}
            <select
              className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-[13px] outline-none focus:border-brand-500"
              value={type}
              onChange={(e) => setType(e.target.value as DialogFieldType)}
            >
              {FIELD_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(`field.type.${tp}` as never)}
                </option>
              ))}
              <option value="attachment">{t("field.type.attachment")}</option>
            </select>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={saving}>
            {t("field.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}