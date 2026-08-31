import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { t } from "@/lib/i18n";

// 代码块 NodeView：右上角语言标识 + 复制按钮；内容经 lowlight 动态高亮（decoration）
export function CodeBlockNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, selected } = props;
  const [copied, setCopied] = useState(false);
  const lang = (node.attrs.language as string | undefined) || "text";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy code failed", e);
    }
  };

  return (
    <NodeViewWrapper data-drag-handle className={"relative my-3 overflow-hidden rounded-lg border border-neutral-200 " + (selected ? "ring-2 ring-brand-500" : "")}>
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100/70 px-2 py-1">
        <span className="text-[11px] font-medium text-neutral-500">{lang}</span>
        <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200" onClick={copy}>
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          {copied ? t("editor.copied") : t("editor.copy")}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto bg-[#F8FAFF] p-3 text-[12.5px] leading-1.6">
        <NodeViewContent className="hljs" />
      </pre>
    </NodeViewWrapper>
  );
}