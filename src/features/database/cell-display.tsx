// 数据库单元格的只读展示部件（选项 / 关联 / 附件胶囊与缩略图）。
// 从 editors.tsx 原样搬出（无逻辑/样式改动），editors.tsx 再统一转出以保持对外导出 API 不变。
import { useEffect, useState } from "react";
import { File as FileIcon, Link2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import type { CellValue, DatabaseField, SelectOption } from "@/types/database";
import { attachmentRefs, parseFieldOptions } from "@/lib/database-values";
import { isImageFile, openAttachment, resolveAssetUrl } from "@/lib/assets";
import { relationRowIds, relationRowLabel, relationTarget, reverseRelationConfig } from "@/lib/relation";
import { useRelationStore } from "@/stores/relation";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";

/** 单选/多选选项彩色圆点 */
export function OptionDot({ option }: { option: SelectOption }) {
  const colors: Record<string, string> = {
    blue: "bg-brand-500",
    green: "bg-green-500",
    orange: "bg-orange-500",
    purple: "bg-purple-500",
    red: "bg-red-500",
    yellow: "bg-yellow-400",
    gray: "bg-neutral-400",
  };
  return <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", colors[option.color] ?? "bg-neutral-400")} />;
}

/** 选项彩色胶囊（单元格显示单选/多选值，带背景色）；compact 用于卡片内紧凑显示；onRemove 提供"输入框中胶囊点 X 删除" */
export function OptionChip({
  option,
  compact = false,
  onRemove,
}: {
  option?: SelectOption;
  compact?: boolean;
  onRemove?: () => void;
}) {
  if (!option) return null;
  const colors: Record<string, string> = {
    blue: "bg-brand-100 text-brand-600",
    green: "bg-green-100 text-green-700",
    orange: "bg-orange-100 text-orange-700",
    purple: "bg-purple-100 text-purple-700",
    red: "bg-red-100 text-red-700",
    yellow: "bg-yellow-100 text-yellow-700",
    gray: "bg-neutral-200 text-neutral-600",
  };
  const size = compact ? "px-1 py-[1px] text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium group/chip",
        size,
        colors[option.color] ?? "bg-neutral-200 text-neutral-600",
      )}
    >
      <span className="max-w-[180px] truncate">{option.name}</span>
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-current/70 hover:bg-black/10 hover:text-current"
          title={t("field.removeOption")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

/** 单选/多选单元格值 → 彩色胶囊展示；compact 用于卡片内紧凑显示；onRemove 启用胶囊 X 删除按钮 */
export function SelectChips({
  field,
  value,
  compact = false,
  onRemove,
}: {
  field: DatabaseField;
  value: CellValue;
  compact?: boolean;
  onRemove?: (newValue: CellValue) => void;
}) {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "select") return null;
  if (field.field_type === "single_select") {
    if (typeof value !== "string") return null;
    return (
      <OptionChip
        option={opts.options.find((x) => x.id === value)}
        compact={compact}
        onRemove={onRemove ? () => onRemove(null) : undefined}
      />
    );
  }
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return (
    <span className={cn("flex flex-wrap", compact ? "gap-0.5" : "gap-1")}>
      {ids.map((id) => (
        <OptionChip
          key={id}
          option={opts.options.find((x) => x.id === id)}
          compact={compact}
          onRemove={onRemove ? () => onRemove(ids.filter((x) => x !== id)) : undefined}
        />
      ))}
    </span>
  );
}

/** 关联行的展示胶囊（label 由调用方解析，目标行已删时为短 id 兜底） */
export function RelationChip({
  label,
  compact = false,
  onRemove,
}: {
  label: string;
  compact?: boolean;
  onRemove?: () => void;
}) {
  const size = compact ? "px-1 py-[1px] text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex max-w-[200px] items-center gap-1 rounded-full bg-neutral-100 font-medium text-neutral-600",
        size,
      )}
    >
      <Link2 className="h-3 w-3 shrink-0 text-neutral-400" />
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-neutral-400 hover:bg-black/10"
          title={t("field.relationRemove")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

/**
 * 反向关系单元格的只读展示：单元格无存储值，value 是调用方实时反查出的来源行 id 数组；
 * 这里用来源库缓存把 id 解析成来源行标题（来源库未加载时降级显示 id）。
 */
export function ReverseRelationChips({
  field,
  value,
  compact = false,
}: {
  field: DatabaseField;
  value: CellValue;
  compact?: boolean;
}) {
  const cfg = reverseRelationConfig(field);
  const sourceViewId = cfg?.source_view_id ?? null;
  const db = useRelationStore((s) => (sourceViewId ? s.data[sourceViewId] : undefined));
  const ids = relationRowIds(value);
  if (ids.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap", compact ? "gap-0.5" : "gap-1")}>
      {ids.map((id) => (
        <RelationChip
          key={id}
          compact={compact}
          label={(db ? relationRowLabel(db, id) : null) ?? (db ? t("field.relationMissing") : id)}
        />
      ))}
    </span>
  );
}

/**
 * 关联单元格的只读展示：单元格只存对端行 id，这里用目标库缓存解析成行标题。
 * 目标库未加载或行已删除时降级显示（不隐藏，避免用户以为关联丢了）。
 */
export function RelationChips({
  field,
  value,
  compact = false,
}: {
  field: DatabaseField;
  value: CellValue;
  compact?: boolean;
}) {
  const targetId = relationTarget(field);
  const db = useRelationStore((s) => (targetId ? s.data[targetId] : undefined));
  const ids = relationRowIds(value);
  if (ids.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap", compact ? "gap-0.5" : "gap-1")}>
      {ids.map((id) => (
        <RelationChip
          key={id}
          compact={compact}
          label={(db ? relationRowLabel(db, id) : null) ?? (db ? t("field.relationMissing") : id)}
        />
      ))}
    </span>
  );
}

/** assets 相对路径 → 可加载 URL（异步解析；path 变为 null 或组件卸载后不再 setState） */
function useAssetUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let alive = true;
    resolveAssetUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

/**
 * 附件缩略图：图片类显示小图，非图片或加载失败回落到图标。
 * 走 asset 协议（CSP 的 img-src 已放行 asset:），失败不抛错只换图标。
 */
export function AttachmentThumb({ name, path, small = false }: { name: string; path: string; small?: boolean }) {
  const image = isImageFile(name);
  const url = useAssetUrl(image ? path : null);
  const [failed, setFailed] = useState(false);
  const size = small ? "h-3.5 w-3.5" : "h-4 w-4";
  if (!image || !url || failed) {
    const Icon = image ? FileIcon : Paperclip;
    return <Icon className={cn(size, "shrink-0 text-neutral-400")} />;
  }
  return (
    <img
      src={url}
      alt={name}
      loading="lazy"
      draggable={false}
      className={cn(size, "shrink-0 rounded object-cover ring-1 ring-inset ring-black/10")}
      onError={() => setFailed(true)}
    />
  );
}

/** 附件胶囊：缩略图 + 文件名，点击用系统默认程序打开（路径越权校验在 Rust 侧） */
export function AttachmentChip({ name, path, compact = false }: { name: string; path: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openAttachment(path);
    } catch (e) {
      logger.error("attachment.open", e);
      toast.error(t("error.openAttachment", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const size = compact ? "px-1 py-[1px] text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <button
      type="button"
      disabled={busy}
      title={t("attachment.clickToOpen")}
      className={cn(
        "inline-flex max-w-[220px] items-center gap-1 rounded-full bg-neutral-100 font-medium text-neutral-600 hover:bg-brand-100 hover:text-brand-600 disabled:opacity-60",
        size,
      )}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        void open();
      }}
    >
      <AttachmentThumb name={name} path={path} small />
      <span className="truncate">{name}</span>
    </button>
  );
}

/** 附件单元格的只读展示：value 为 [{name,path}] 数组（空则调用方给占位） */
export function AttachmentChips({ value, compact = false }: { value: CellValue; compact?: boolean }) {
  const refs = attachmentRefs(value);
  if (refs.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap", compact ? "gap-0.5" : "gap-1")}>
      {refs.map((a) => (
        <AttachmentChip key={a.path} name={a.name} path={a.path} compact={compact} />
      ))}
    </span>
  );
}

/** 进度单元格展示：0-100 进度条 + 右侧百分比数字。空值给 0% 灰条。 */
export function ProgressCell({ value, compact = false }: { value: CellValue; compact?: boolean }) {
  const raw = typeof value === "number" ? value : null;
  const pct = raw === null ? 0 : Math.min(100, Math.max(0, raw));
  const done = raw !== null && pct >= 100;
  return (
    <span className={cn("flex items-center gap-1.5", compact ? "w-full" : "w-full pr-1")}>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        <span
          className={cn("block h-full rounded-full transition-all", done ? "bg-green-500" : "bg-brand-500")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums text-[11px] text-neutral-500">
        {raw === null ? "" : Math.round(pct) + "%"}
      </span>
    </span>
  );
}

/** 星级展示：实心星数量 = 四舍五入(value)；空值给全空心星（compact 时给更小字号）。 */
export function RatingCell({ value, max, compact = false }: { value: CellValue; max: number; compact?: boolean }) {
  const raw = typeof value === "number" ? value : null;
  const filled = raw === null ? 0 : Math.min(max, Math.max(0, Math.round(raw)));
  const size = compact ? "text-[10px]" : "text-[13px]";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 leading-none", size)}
      title={raw === null ? undefined : String(raw)}
    >
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < filled ? "text-amber-400" : "text-neutral-300 dark:text-neutral-600"}>
          {i < filled ? "★" : "☆"}
        </span>
      ))}
    </span>
  );
}
