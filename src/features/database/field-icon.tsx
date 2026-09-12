import type { ReactNode } from "react";
import {
  Calendar,
  CheckSquare,
  CircleDot,
  Clock,
  Hash,
  History,
  ListChecks,
  Mail,
  Phone,
  Type as TypeIcon,
  Link as LinkIcon,
} from "lucide-react";
import type { FieldType } from "@/types/database";

/** 字段类型 → 图标（对齐 AppFlowy 行详情的属性图标；RowDetail 使用） */
export function fieldIcon(type: FieldType): ReactNode {
  const cls = "h-3.5 w-3.5 shrink-0 text-neutral-400";
  switch (type) {
    case "text":
      return <TypeIcon className={cls} />;
    case "number":
      return <Hash className={cls} />;
    case "date":
      return <Calendar className={cls} />;
    case "single_select":
      return <CircleDot className={cls} />;
    case "multi_select":
      return <ListChecks className={cls} />;
    case "checkbox":
      return <CheckSquare className={cls} />;
    case "url":
      return <LinkIcon className={cls} />;
    case "phone":
      return <Phone className={cls} />;
    case "email":
      return <Mail className={cls} />;
    case "created_at":
      return <Clock className={cls} />;
    case "last_edited_at":
      return <History className={cls} />;
  }
}
