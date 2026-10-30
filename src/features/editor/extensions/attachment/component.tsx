import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { resolveAssetUrl } from "@/lib/assets/assets";
import { attachmentKindOf, type AttachmentKind } from "@/lib/assets/attachment-kind";

// 附件卡片：点文件名那行仍走 Rust 的 open_asset 交给系统默认程序（路径越权校验在 Rust 侧），
// 图片 / 音频 / 视频 / PDF 另外长出一块预览。不用 window.open(assetUrl)：WebView 对非图片/媒体的
// asset 协议 URI 不会拉起外部程序。

/** 这几种类型值得直接展开预览（PDF 的 iframe 太重，默认收起） */
function autoExpand(kind: AttachmentKind): boolean {
  return kind === "image" || kind === "audio" || kind === "video";
}

export function AttachmentNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node } = props;
  const [busy, setBusy] = useState(false);

  const raw = (node.attrs.src as string | undefined) ?? "";
  const name = (node.attrs.name as string | undefined) ?? raw.split("/").pop() ?? t("attachment.defaultName");
  const kind = attachmentKindOf(name, raw);
  const previewable = raw !== "" && kind !== "other";
  const [expanded, setExpanded] = useState(() => autoExpand(kind));
  const [url, setUrl] = useState<string | null>(null);

  // URL 只在预览真正展开时才解析：一份文档里几十个附件不必都去问一遍数据目录
  useEffect(() => {
    if (!raw || !expanded) {
      setUrl(null);
      return;
    }
    let alive = true;
    resolveAssetUrl(raw).then(
      (value) => {
        if (alive) setUrl(value);
      },
      (e: unknown) => {
        logger.error("attachment.previewUrl", e);
        if (alive) setUrl(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [raw, expanded]);

  const open = async () => {
    if (!raw || busy) return;
    setBusy(true);
    try {
      await invoke("open_asset", { relative: raw });
    } catch (e) {
      logger.error("attachment.open", e);
      toast.error(t("error.openAttachment", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <button
      type="button"
      onClick={open}
      disabled={!raw || busy}
      className="flex w-full max-w-[min(420px,100%)] items-center gap-3 rounded-lg border border-neutral-300 bg-neutral-100/50 px-3 py-2.5 text-left hover:border-brand-500 hover:bg-brand-100/30 disabled:opacity-60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white shadow-sm">
        {kind === "image" ? (
          <ImageIcon className="h-4.5 w-4.5 text-neutral-500" />
        ) : (
          <FileIcon className="h-4.5 w-4.5 text-neutral-500" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-neutral-800">{name}</span>
        <span className="block text-[11px] text-neutral-400">{t("attachment.clickToOpen")}</span>
      </span>
    </button>
  );

  if (!previewable) {
    return (
      <NodeViewWrapper data-drag-handle className="my-3 w-full max-w-full">
        {card}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="my-3 w-full max-w-full">
      <div className="flex items-start gap-1">
        {/* 拖拽手柄只给文件名那一行：整块包成手柄会抢走播放器控件的 mousedown，点播放变成拖附件 */}
        <div className="min-w-0 flex-1" data-drag-handle>
          {card}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={t(expanded ? "attachment.collapse" : "attachment.preview")}
          className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div
          // 播放器/PDF 查看器里的空格、方向键属于控件，不该冒泡到 ProseMirror 变成打字与移动光标
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800"
        >
          {url ? (
            <AttachmentPreview kind={kind} url={url} name={name} />
          ) : (
            <div className="px-3 py-4 text-[12px] text-neutral-400">{t("attachment.previewLoading")}</div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

function AttachmentPreview({ kind, url, name }: { kind: AttachmentKind; url: string; name: string }) {
  switch (kind) {
    case "image":
      return <img src={url} alt={name} className="max-h-[420px] max-w-full" />;
    case "audio":
      return <audio controls src={url} className="w-full" />;
    case "video":
      // preload=metadata：只取时长与首帧，别为了看个附件把整段视频读进内存
      return <video controls preload="metadata" src={url} className="max-h-[480px] w-full" />;
    case "pdf":
      // WebView2 自带 PDF 查看器，iframe 直接可翻页；高度给足，否则只能看到首页一角
      return <iframe title={name} src={url} className="h-[70vh] w-full border-0 bg-white" />;
    default:
      return null;
  }
}
