import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import mermaid from "mermaid";
import { t } from "@/lib/i18n";

let renderSeq = 0;

async function renderMermaid(code: string): Promise<string> {
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: dark ? "dark" : "default",
    fontFamily: "inherit",
  });
  const { svg } = await mermaid.render(`mmd-${++renderSeq}`, code);
  return svg;
}

// Mermaid NodeView：非编辑态渲染 SVG（双击切编辑）；编辑态 textarea + 防抖实时预览
export function MermaidNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const code = (node.attrs.code as string) ?? "";
  const [editing, setEditing] = useState(!code); // 空图表直接进入编辑
  const [draft, setDraft] = useState(code);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setDraft(code), [code]);

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [editing]);

  // 渲染：非编辑态渲染已保存 code；编辑态防抖渲染草稿（实时预览）
  useEffect(() => {
    const src = editing ? draft : code;
    if (!src.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(
      () => {
        renderMermaid(src)
          .then((s) => {
            if (cancelled) return;
            setSvg(s);
            setError(null);
          })
          .catch((e: unknown) => {
            if (cancelled) return;
            setError(String(e));
          });
      },
      editing ? 400 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, draft, editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== code) updateAttributes({ code: draft });
  };

  return (
    <NodeViewWrapper
      className={"group/mermaid relative my-3 " + (selected ? "ring-2 ring-brand-500 rounded-lg" : "")}
      data-drag-handle
    >
      {editing ? (
        <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(4, draft.split("\n").length + 1)}
            className="w-full resize-y rounded border border-neutral-200 bg-white p-2 font-mono text-[13px] outline-none focus:border-brand-500"
            placeholder={"graph TD\n  A --> B"}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
              if (e.key === "Escape") {
                setDraft(code);
                setEditing(false);
              }
            }}
          />
          <div className="mt-1 flex justify-end gap-1 text-[11px] text-neutral-400">
            <span>Ctrl/Cmd + Enter 保存 · Esc 取消</span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white p-3" onDoubleClick={() => setEditing(true)}>
          {code.trim() ? (
            error ? (
              <div className="space-y-1 py-2 text-center">
                <div className="text-[13px] text-red-600">{t("mermaid.renderFailed")}</div>
                <div className="mx-auto max-h-[120px] w-[90%] overflow-y-auto rounded bg-neutral-100 p-2 text-left font-mono text-[11px] text-neutral-500">
                  {error}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: svg }} />
            )
          ) : (
            <div className="text-center text-[13px] text-neutral-400">{t("mermaid.placeholder")}</div>
          )}
        </div>
      )}
      {/* 悬浮操作：编辑态为取消/确认，非编辑态仅删除（编辑入口为双击） */}
      <div className="absolute right-2 top-2 hidden gap-1 group-hover/mermaid:flex">
        {editing ? (
          <>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900"
              title={t("common.cancel")}
              onClick={() => {
                setDraft(code);
                setEditing(false);
              }}
            >
              <X className="h-4 w-4" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white hover:bg-brand-700"
              title={t("common.confirm")}
              onClick={commit}
            >
              ✓
            </button>
          </>
        ) : (
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900"
            title={t("common.delete")}
            onClick={() => deleteNode()}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}
