import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRightLeft,
  Banknote,
  Calendar,
  CheckSquare,
  CircleDot,
  Clock,
  Combine,
  Gauge,
  Hash,
  History,
  Link2,
  ListChecks,
  Mail,
  Paperclip,
  Phone,
  Star,
  Type as TypeIcon,
  Sigma,
  Link as LinkIcon,
} from "lucide-react";
import type { FieldType } from "@/types/database";

/** 字段类型 → 图标（对齐 AppFlowy 行详情的属性图标；RowDetail 使用） */
const FIELD_ICONS: Record<FieldType, LucideIcon> = {
  text: TypeIcon,
  number: Hash,
  progress: Gauge,
  rating: Star,
  currency: Banknote,
  formula: Sigma,
  date: Calendar,
  single_select: CircleDot,
  multi_select: ListChecks,
  checkbox: CheckSquare,
  url: LinkIcon,
  phone: Phone,
  email: Mail,
  created_at: Clock,
  last_edited_at: History,
  relation: Link2,
  rollup: Combine,
  reverse_relation: ArrowRightLeft,
  attachment: Paperclip,
};

export function fieldIcon(type: FieldType): ReactNode {
  const Icon = FIELD_ICONS[type];
  return <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />;
}
