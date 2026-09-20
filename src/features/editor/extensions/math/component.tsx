import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { t } from "@/lib/i18n";

// 公式 NodeView：非编辑态渲染 KaTeX；双击切编辑态（textarea 写 TeX，Ctrl+Enter 保存 / Esc 取消）
export function MathNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const tex = (node.attrs.tex as string) ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tex);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(tex);
  }, [tex]);

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== tex) updateAttributes({ tex: draft });
  };

  const rendered = (() => {
    try {
      return katex.renderToString(tex || "\\text{}", {
        throwOnError: false,
        displayMode: true,
      });
    } catch (e) {
      return `<span style="color:#d92d20">Invalid TeX</span>`;
    }
  })();

  return (
    <NodeViewWrapper
      className={"group/math relative my-3 " + (selected ? "ring-2 ring-brand-500 rounded-lg" : "")}
      data-drag-handle
    >
      {editing ? (
        <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(2, draft.split("\n").length)}
            className="w-full resize-y rounded border border-neutral-200 bg-white p-2 font-mono text-[13px] outline-none focus:border-brand-500"
            placeholder={t("math.edit")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
              if (e.key === "Escape") {
                setDraft(tex);
                setEditing(false);
              }
            }}
          />
          <div className="mt-1 flex justify-end gap-1 text-[11px] text-neutral-400">
            <span>{t("editor.saveHint")}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white p-3" onDoubleClick={() => setEditing(true)}>
          {tex ? (
            <div className="overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: rendered }} />
          ) : (
            <div className="text-center text-[13px] text-neutral-400">{t("math.placeholder")}</div>
          )}
        </div>
      )}
      {/* 悬浮操作：编辑态为取消/确认，非编辑态仅删除（编辑入口为双击） */}
      <div className="absolute right-2 top-2 hidden gap-1 group-hover/math:flex">
        {editing ? (
          <>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900"
              title={t("common.cancel")}
              onClick={() => {
                setDraft(tex);
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
            title={t("math.delete")}
            onClick={() => deleteNode()}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}
