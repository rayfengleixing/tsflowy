import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import mermaid from "mermaid";
import { t } from "@/lib/i18n";

let renderSeq = 0;
// 离屏渲染宿主：mermaid.render 不传容器时会把临时 div 挂到 body 的正常文档流，
// 渲染期间短暂撑高文档导致滚动条闪现；统一渲染进固定在视口外的宿主元素
let renderHost: HTMLDivElement | null = null;
function getRenderHost(): HTMLDivElement {
  if (!renderHost?.isConnected) {
    renderHost = document.createElement("div");
    renderHost.style.position = "fixed";
    renderHost.style.left = "-65535px";
    renderHost.style.top = "0";
    document.body.appendChild(renderHost);
  }
  return renderHost;
}

async function renderMermaid(code: string): Promise<string> {
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({
    startOnLoad: false,
    // 必须 strict：loose 会让 mermaid 跳过对输出 SVG 的 DOMPurify 清洗，
    // 渲染结果又直接进 dangerouslySetInnerHTML，导入不可信备份即可执行脚本。
    // securityLevel 在 mermaid 的 secure 白名单里，图表内 %%{init}%% 覆盖不了它。
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "inherit",
  });
  const id = `mmd-${++renderSeq}`;
  try {
    // 语法预校验：失败直接抛给上层显示（组件内错误框），不进 render——
    // mermaid v12 的 render 失败时会把错误内容留在 body 末尾的临时元素里，
    // 表现为"错误提示显示在整个应用界面之外"
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code, getRenderHost());
    return svg;
  } finally {
    // 兜底清理：render 成功/失败后残留的临时元素一并移除（#<id> 与带 d 前缀的变体）
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

// Mermaid NodeView：非编辑态渲染 SVG（双击切编辑）；编辑态仅编辑 textarea，退出时渲染草稿
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

  // 渲染：仅非编辑态渲染已保存 code。编辑态跳过——草稿不展示，
  // 且每次防抖渲染都会往 DOM 挂临时元素（编辑中持续触发，即使离屏也无谓开销）
  useEffect(() => {
    if (editing) return;
    if (!code.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      renderMermaid(code)
        .then((s) => {
          if (cancelled) return;
          setSvg(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(String(e));
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, editing]);

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
