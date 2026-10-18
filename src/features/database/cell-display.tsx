// 数据库单元格的只读展示部件（选项 / 关联 / 附件胶囊与缩略图）。
// 从 editors.tsx 原样搬出（无逻辑/样式改动），editors.tsx 再统一转出以保持对外导出 API 不变。
import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, File as FileIcon, Link2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import type { CellValue, DatabaseField, FieldType, SelectOption } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import {
  attachmentRefs,
  formatCellValue,
  isSingleOptionKind,
  parseFieldOptions,
  ratingMax,
} from "@/lib/database-values";
import { isImageFile, openAttachment, resolveAssetUrl } from "@/lib/assets";
import { cellLinkHref, isLinkFieldType, type LinkFieldKind } from "@/lib/database-link";
import {
  relationRowIds,
  relationRowLabel,
  relationTarget,
  reverseRelationConfig,
  type RelationDb,
} from "@/lib/relation";
import { openRowInView } from "@/lib/deep-link";
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
      {option.tone === "done" && <Check className="h-3 w-3 shrink-0" />}
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
  if (isSingleOptionKind(field.field_type)) {
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

/** 关联行的展示胶囊（label 由调用方解析，目标行已删时为短 id 兜底）。
 *  onOpen 给定时整颗胶囊可点（跳去对端那一行）；编辑态只给 onRemove，仍是不可点的 span。 */
export function RelationChip({
  label,
  compact = false,
  onRemove,
  onOpen,
}: {
  label: string;
  compact?: boolean;
  onRemove?: () => void;
  onOpen?: () => void;
}) {
  const size = compact ? "px-1 py-[1px] text-[10px]" : "px-2 py-0.5 text-[11px]";
  const cls = cn(
    "inline-flex max-w-[200px] items-center gap-1 rounded-full font-medium",
    size,
    onOpen
      ? "bg-neutral-100 text-neutral-600 hover:bg-brand-100 hover:text-brand-600"
      : "bg-neutral-100 text-neutral-600",
  );
  const body = (
    <>
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
    </>
  );
  if (!onOpen) return <span className={cls}>{body}</span>;
  return (
    <button
      type="button"
      title={t("field.relationOpen")}
      className={cls}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {body}
    </button>
  );
}

/** 胶囊的可点入口：对端库里确有这一行才给（行已删时点了只会打开一页空白） */
function rowJump(viewId: string | null, db: RelationDb | undefined, id: string): (() => void) | undefined {
  if (!viewId || !db || relationRowLabel(db, id) === null) return undefined;
  return () => openRowInView(viewId, id);
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
          onOpen={rowJump(sourceViewId, db, id)}
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
          onOpen={rowJump(targetId, db, id)}
        />
      ))}
    </span>
  );
}

/** assets 相对路径 → 可加载 URL（异步解析；path 变为 null 或组件卸载后不再 setState） */
export function useAssetUrl(path: string | null): string | null {
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

/** url / email 单元格里的可点链接：点击把地址交给系统默认程序（浏览器 / 邮件客户端）。
 *  与附件胶囊同一套手感——点文字是打开，点格子的其它位置照常进编辑。 */
export function CellLink({ kind, value }: { kind: LinkFieldKind; value: string }) {
  const href = cellLinkHref(kind, value);
  const [busy, setBusy] = useState(false);
  if (!href) {
    // 协议不在白名单里（javascript:、file:…）或根本不成其为一个地址：退回纯文本
    return <span className="truncate">{value}</span>;
  }
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openUrl(href);
    } catch (e) {
      logger.error(kind === "email" ? "email cell open failed" : "url cell open failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      title={t(kind === "email" ? "email.clickToOpen" : "url.clickToOpen")}
      className="min-w-0 truncate text-left text-[13px] text-brand-600 underline-offset-2 hover:underline disabled:opacity-60"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        void open();
      }}
    >
      {value}
    </button>
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

// ---------- 展示臂（Strategy 的视图侧） ----------
// 类型 → 专用部件的分派原来在 grid-parts.CellDisplay 与 RowDetail 各写了一份（七处 / 六处
// field_type 判断，样式还容易一边改一边漏）。收成下面这张表：两条路径只差 variant，
// 表格带列内包裹层，行详情裸渲染。新增类型只需在 DEDICATED_DISPLAYS 补一行。

export interface CellDisplayProps {
  field: DatabaseField;
  value: CellValue;
  /** grid = 表格单元格（带列内边距/裁剪包裹层）；detail = 行详情属性区（裸渲染） */
  variant: "grid" | "detail";
  /** 胶囊上的 × 删除入口，仅表格/编辑态传 */
  onChipRemove?: (newValue: CellValue) => void;
}

export interface CellDisplayContent {
  node: ReactNode;
  /** grid 变体的包裹层 class；detail 变体恒 null */
  wrapClass: string | null;
}

const GRID_BAR = "flex h-full w-full items-center px-2";
const GRID_TRUNCATE = "flex h-full w-full items-center truncate px-2";
const gridEmpty = <span className="text-neutral-300" />;
const detailEmpty = <span className="text-neutral-300">{t("rowDetail.empty")}</span>;

const isEmptyArray = (value: CellValue): boolean => Array.isArray(value) && value.length === 0;
const hasItems = (value: CellValue): boolean => Array.isArray(value) && value.length > 0;

const selectDisplay = ({ field, value, onChipRemove }: CellDisplayProps, grid: boolean): CellDisplayContent => ({
  node: grid && isEmptyArray(value) ? gridEmpty : <SelectChips field={field} value={value} onRemove={onChipRemove} />,
  wrapClass: grid ? GRID_TRUNCATE : null,
});
const relationDisplay = ({ field, value }: CellDisplayProps, grid: boolean): CellDisplayContent => ({
  node: grid && isEmptyArray(value) ? gridEmpty : <RelationChips field={field} value={value} />,
  wrapClass: grid ? GRID_TRUNCATE : null,
});

/** 链接列（url / email）：只有解析得出安全目标时才换成可点部件，否则交回文本兜底 */
const linkDisplay = ({ field, value }: CellDisplayProps, grid: boolean): CellDisplayContent | null => {
  if (!isLinkFieldType(field.field_type)) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return { node: <CellLink kind={field.field_type} value={value} />, wrapClass: grid ? GRID_TRUNCATE : null };
};

/** 有专用部件的类型；返回 null 表示该变体按普通文本渲染（由调用方兜底）。
 *  新增类型只需在这里补一行，表格与行详情两条路径同时生效。 */
const DEDICATED_DISPLAYS: Partial<
  Record<FieldType, (p: CellDisplayProps, grid: boolean) => CellDisplayContent | null>
> = {
  // 复选框没有部件，居中打个勾；行详情面板沿用文本（"是"），保持原样
  checkbox: ({ value }, grid) =>
    grid
      ? {
          node: value === true ? "✓" : "",
          wrapClass: "flex h-full items-center justify-center text-[13px] text-brand-600",
        }
      : null,
  progress: ({ value }, grid) => ({ node: <ProgressCell value={value} />, wrapClass: grid ? GRID_BAR : null }),
  rating: ({ value, field }, grid) => ({
    node: <RatingCell value={value} max={ratingMax(parseFieldOptions(field.options))} />,
    wrapClass: grid ? GRID_BAR : null,
  }),
  single_select: selectDisplay,
  status: selectDisplay,
  multi_select: selectDisplay,
  url: linkDisplay,
  email: linkDisplay,
  relation: relationDisplay,
  // 反向关系是只读虚拟列：value 由调用方实时反查（来源行 id 数组），这里解析成来源行标题
  reverse_relation: ({ field, value }, grid) => ({
    node: hasItems(value) ? <ReverseRelationChips field={field} value={value} /> : grid ? gridEmpty : detailEmpty,
    wrapClass: grid ? GRID_TRUNCATE : null,
  }),
  attachment: ({ value }, grid) => ({
    node: hasItems(value) ? <AttachmentChips value={value} /> : grid ? gridEmpty : detailEmpty,
    wrapClass: grid ? GRID_TRUNCATE : null,
  }),
};

export function cellDisplayContent(p: CellDisplayProps): CellDisplayContent | null {
  const entry = DEDICATED_DISPLAYS[p.field.field_type];
  return entry ? entry(p, p.variant === "grid") : null;
}

/** 只读单元格值（看板/日历/列表/画廊等卡片、属性行共用）：
 *  专用部件走详情臂，其余按文本渲染。空值不给占位文案——由调用方决定隐藏还是显示。 */
export function CellReadValue({ field, value }: { field: DatabaseField; value: CellValue }) {
  const custom = cellDisplayContent({ field, value, variant: "detail" });
  if (custom) return <>{custom.node}</>;
  const text = formatCellValue(field.field_type, value, parseFieldOptions(field.options));
  return (
    <span
      className={cn(
        "truncate",
        isReadonlyType(field.field_type)
          ? "text-neutral-400 dark:text-neutral-500"
          : "text-neutral-800 dark:text-neutral-200",
      )}
    >
      {text}
    </span>
  );
}
