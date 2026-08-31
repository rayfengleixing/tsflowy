import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { t } from "@/lib/i18n";

// 代码块 NodeView：右上角语言标识 + 复制按钮；内容经 lowlight 动态高亮（decoration）
export function CodeBlockNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, selected, updateAttributes } = props;
  const [copied, setCopied] = useState(false);
  const [editingLang, setEditingLang] = useState(false);
  const [langDraft, setLangDraft] = useState("");
  const preRef = useRef<HTMLPreElement>(null);
  const lang = (node.attrs.language as string | undefined) || "text";

  const commitLang = () => {
    setEditingLang(false);
    const v = langDraft.trim();
    if (v && v !== lang) updateAttributes({ language: v });
  };

  const copy = async () => {
    try {
      // 用 DOM innerText（pre 设了 white-space: pre，保留多行换行）；textBetween 不可靠只返回首行
      const text = preRef.current?.innerText ?? node.textContent ?? "";
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy code failed", e);
    }
  };

  return (
    <NodeViewWrapper data-drag-handle className={"relative my-3 overflow-hidden border border-neutral-200 " + (selected ? "ring-2 ring-brand-500" : "")}>
      <div className="flex items-center justify-between border-b border-neutral-200 bg-[#F8FAFF] px-2 py-1">
        {editingLang ? (
          <input
            autoFocus
            className="h-5 w-24 border border-brand-500 bg-white px-1 text-[11px] text-neutral-700 outline-none"
            value={langDraft}
            onChange={(e) => setLangDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLang();
              if (e.key === "Escape") setEditingLang(false);
            }}
            onBlur={commitLang}
          />
        ) : (
          <span
            className="cursor-text px-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-200"
            title="双击修改语言"
            onDoubleClick={() => {
              setLangDraft(lang);
              setEditingLang(true);
            }}
          >
            {lang}
          </span>
        )}
        <button className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200" onClick={copy}>
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          {copied ? t("editor.copied") : t("editor.copy")}
        </button>
      </div>
      <pre ref={preRef} className="m-0 overflow-x-auto whitespace-pre bg-[#F8FAFF] p-3 text-[12.5px] leading-1.6 text-neutral-700">
        <NodeViewContent />
      </pre>
    </NodeViewWrapper>
  );
}