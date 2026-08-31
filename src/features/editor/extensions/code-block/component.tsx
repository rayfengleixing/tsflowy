import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { t } from "@/lib/i18n";

// 代码块 NodeView：右上角语言标识 + 复制按钮；内容经 lowlight 动态高亮（decoration）
export function CodeBlockNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, selected, updateAttributes, editor, getPos } = props;
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
      // 用 editor.state.doc.textBetween 提取：保留块内换行（node.textContent 会丢失换行边界）
      let text = "";
      if (typeof getPos === "function" && editor) {
        const pos = getPos();
        if (typeof pos === "number") {
          const n = editor.state.doc.nodeAt(pos);
          if (n) text = n.textBetween(0, n.content.size, "\n");
        }
      }
      if (!text) text = preRef.current?.innerText ?? node.textContent ?? "";
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy code failed", e);
    }
  };

  return (
    <NodeViewWrapper data-drag-handle className={"relative my-3 overflow-hidden rounded-lg border border-neutral-200 " + (selected ? "ring-2 ring-brand-500" : "")}>
      <div className="flex items-center justify-between border-b border-neutral-200 bg-[#F8FAFF] px-2 py-1">
        {editingLang ? (
          <input
            autoFocus
            className="h-5 w-24 rounded border border-brand-500 bg-white px-1 text-[11px] text-neutral-700 outline-none"
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
            className="cursor-text rounded px-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-200"
            title="双击修改语言"
            onDoubleClick={() => {
              setLangDraft(lang);
              setEditingLang(true);
            }}
          >
            {lang}
          </span>
        )}
        <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200" onClick={copy}>
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          {copied ? t("editor.copied") : t("editor.copy")}
        </button>
      </div>
      <pre ref={preRef} className="m-0 overflow-x-auto bg-[#F8FAFF] p-3 text-[12.5px] leading-1.6 text-neutral-700">
        <NodeViewContent />
      </pre>
    </NodeViewWrapper>
  );
}