// AiPanel 与消息气泡共用的展示小件（从 AiPanel.tsx 原样搬出，无逻辑/样式改动）
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { resolveAssetUrl } from "@/lib/assets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 图片附件缩略图：会话里存的是 assets/ 相对路径，URL 需异步解析，
 * 因此组件内部自持状态；path 变化或卸载后不再 setState。
 */
export function ImageThumb({ path, name, onRemove }: { path: string; name: string; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    resolveAssetUrl(path).then(
      (u) => {
        if (alive) setUrl(u);
      },
      () => {
        if (alive) setUrl(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="relative">
      {/* 缩略图靠 asset 协议加载本地文件；解析失败时留一块占位灰底 */}
      {url ? (
        <img
          src={url}
          alt={name}
          title={name}
          className="h-14 w-14 rounded-md border border-neutral-200 object-cover dark:border-neutral-700"
        />
      ) : (
        <div className="h-14 w-14 rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800" />
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={t("ai.removeImage")}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-700 text-white hover:bg-neutral-900"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

/** 历史会话行右侧的悬浮操作（改名 / 归档 / 删除） */
export function RowAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "shrink-0 rounded p-1 text-neutral-400 opacity-0 hover:text-neutral-600 group-hover:opacity-100 dark:hover:text-neutral-200",
        danger && "hover:text-red-500",
      )}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function QuickButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
