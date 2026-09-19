import { useState } from "react";
import { File as FileIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";

// 附件文件卡片：点击交给系统默认程序打开（走 Rust 的 open_asset，路径越权校验在 Rust 侧）。
// 不用 window.open(assetUrl)：WebView 对非图片/媒体的 asset 协议 URI 不会拉起外部程序。
export function AttachmentNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node } = props;
  const [busy, setBusy] = useState(false);

  const raw = (node.attrs.src as string | undefined) ?? "";
  const name = (node.attrs.name as string | undefined) || raw.split("/").pop() || "附件";

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

  return (
    <NodeViewWrapper data-drag-handle className="my-3 w-full max-w-full">
      <button
        type="button"
        onClick={open}
        disabled={!raw || busy}
        className="flex w-full max-w-[min(420px,100%)] items-center gap-3 rounded-lg border border-neutral-300 bg-neutral-100/50 px-3 py-2.5 text-left hover:border-brand-500 hover:bg-brand-100/30 disabled:opacity-60"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white shadow-sm">
          <FileIcon className="h-4.5 w-4.5 text-neutral-500" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-neutral-800">{name}</span>
          <span className="block text-[11px] text-neutral-400">{t("attachment.clickToOpen")}</span>
        </span>
      </button>
    </NodeViewWrapper>
  );
}
