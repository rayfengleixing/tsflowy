import { useEffect, useState } from "react";
import { File as FileIcon } from "lucide-react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { resolveAssetUrl } from "@/lib/assets";

// 附件文件卡片：点击在新窗口打开（asset 协议）
export function AttachmentNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, selected } = props;
  const [url, setUrl] = useState("");

  useEffect(() => {
    let alive = true;
    const raw = (node.attrs.src as string | undefined) ?? "";
    if (!raw) return;
    resolveAssetUrl(raw)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch((e) => console.error("resolve attachment failed", raw, e));
    return () => {
      alive = false;
    };
  }, [node.attrs.src]);

  const name = (node.attrs.name as string | undefined) || (node.attrs.src as string | undefined)?.split("/").pop() || "附件";

  return (
    <NodeViewWrapper data-drag-handle className={"my-3 " + (selected ? "ring-2 ring-brand-500 rounded-lg" : "")}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex max-w-[420px] items-center gap-3 rounded-lg border border-neutral-300 bg-neutral-100/50 px-3 py-2.5 hover:border-brand-500 hover:bg-brand-100/30"
        onClick={(e) => {
          e.preventDefault();
          if (url) window.open(url, "_blank");
        }}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white shadow-sm">
          <FileIcon className="h-4.5 w-4.5 text-neutral-500" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-neutral-800">{name}</span>
          <span className="block text-[11px] text-neutral-400">{t_attachment_note()}</span>
        </span>
      </a>
    </NodeViewWrapper>
  );
}

function t_attachment_note(): string {
  return "附件 · 点击打开";
}