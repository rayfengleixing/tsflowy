import { type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element as HastElement, Root as HastRoot, RootContent } from "hast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import "highlight.js/styles/github.css";
import { aiErrorText } from "@/lib/ai";
import { citationViewId, remarkAiCitations } from "@/lib/ai-citation";
import { MATH_CLASS_BLOCK, MATH_CLASS_INLINE, remarkAiMath } from "@/lib/ai-math";
import { openRowInView } from "@/lib/deep-link";
import { t } from "@/lib/i18n";
import { renderMermaid } from "@/lib/mermaid-render";
import { renderTex } from "@/lib/katex-render";
import { cn } from "@/lib/utils";

// lowlight 与它的 common 语言集有几百 KB，和编辑器代码块共用同一份（lib/code-highlight）。
// 静态引入会把这份体积拖进主包，改为答案里出现代码块时才加载并缓存。
let lowlightPromise: Promise<(typeof import("@/lib/code-highlight"))["lowlight"]> | null = null;
function getLowlight() {
  return (lowlightPromise ??= import("@/lib/code-highlight").then((m) => m.lowlight));
}

/** hast 的 className 可能是字符串或数组，统一成空格串再判断 */
function classList(value: unknown): string {
  if (Array.isArray(value)) return value.join(" ");
  return typeof value === "string" ? value : "";
}

type HastAny = HastRoot | RootContent;

/** 取一个 hast 子树的纯文本：公式 TeX、mermaid 与代码块内容都要原始源码，不能用已渲染的 React children */
function hastText(node: HastAny | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "element" || node.type === "root") return node.children.map(hastText).join("");
  return "";
}

function isHastElement(node: RootContent): node is HastElement {
  return node.type === "element";
}

/** 围栏代码块的语言名：className 形如 "language-ts" */
function fenceLang(className: unknown): string {
  const m = /(?:^|\s)language-([A-Za-z0-9_+-]+)/.exec(classList(className));
  return m ? m[1] : "";
}

/** highlight.js 产出的 hast 只有 span / text 两类；其余节点类型不会出现，按空处理 */
function hastToReact(nodes: RootContent[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const at = `${key}-${i}`;
    if (n.type === "text") return <span key={at}>{n.value}</span>;
    if (n.type === "element")
      return (
        <span key={at} className={classList(n.properties.className) || undefined}>
          {hastToReact(n.children, at)}
        </span>
      );
    return null;
  });
}

/**
 * 围栏代码高亮：与编辑器代码块同一套 lowlight 语言集与 github.css 配色。
 * 语言没注册（模型臆造的别名）时退回纯文本，不做自动嗅探——嗅探会把 ts 认成别的语言。
 */
function CodeBody({ lang, code }: { lang: string; code: string }) {
  const [nodes, setNodes] = useState<ReactNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getLowlight()
      .then((hl) => {
        if (cancelled) return;
        setNodes(hl.registered(lang) ? hastToReact(hl.highlight(lang, code).children, "hl") : null);
      })
      .catch(() => {
        if (!cancelled) setNodes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, code]);
  return nodes ? <>{nodes}</> : <>{code}</>;
}

const CODE_PRE =
  "my-1.5 overflow-x-auto rounded-md bg-neutral-200/60 p-2 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200";

function MermaidSource({ code, hint }: { code: string; hint: boolean }) {
  return (
    <div className="my-1.5">
      {hint && <div className="mb-1 text-[11px] text-neutral-500">{t("ai.mermaidRenderFailed")}</div>}
      <pre className={CODE_PRE}>
        <code className="block font-mono text-[11px] leading-relaxed">{code}</code>
      </pre>
    </div>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!code.trim()) {
      setSvg("");
      setFailed(false);
      return;
    }
    let cancelled = false;
    // 每个流式增量都试渲染的话，半截语法必然先失败一次，图上会闪一帧红字提示；
    // 等笔停 350ms 再画，图与最终错误提示都只出现一次
    const timer = setTimeout(() => {
      renderMermaid(code)
        .then((s) => {
          if (cancelled) return;
          setSvg(s);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSvg("");
          setFailed(true);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);
  if (failed) return <MermaidSource code={code} hint />;
  if (!svg) return <MermaidSource code={code} hint={false} />;
  return (
    <div
      className="my-1.5 overflow-x-auto rounded-md border border-neutral-200 py-2 dark:border-neutral-700"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** 公式：katex 按需加载，加载期间（以及流式写公式的途中）先显示 TeX 原文 */
function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let cancelled = false;
    void renderTex(tex, display).then((v) => {
      if (!cancelled) setHtml(v);
    });
    return () => {
      cancelled = true;
    };
  }, [tex, display]);
  const className = display ? "ai-math-block" : undefined;
  if (!html) return <span className={className}>{tex}</span>;
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * AI 回复的 Markdown 渲染（GFM：表格/任务列表/删除线/自动链接；代码高亮、mermaid 图与 TeX 公式）。
 * AI 输出按纯 Markdown 解析、不渲染原始 HTML，天然免疫注入的 <script>/<iframe>。
 * 链接点击走系统浏览器（preventDefault 防止 WebView2 整页跳转把应用冲掉）。
 */
const components: Components = {
  p: ({ node: _n, ...props }) => <p className="my-1 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _n, ...props }) => <h1 className="mt-2 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h2: ({ node: _n, ...props }) => <h2 className="mt-2 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h3: ({ node: _n, ...props }) => <h3 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0" {...props} />,
  h4: ({ node: _n, ...props }) => <h4 className="mt-2 mb-1 text-[12px] font-semibold first:mt-0" {...props} />,
  ul: ({ node: _n, ...props }) => <ul className="my-1 list-disc space-y-0.5 pl-4" {...props} />,
  ol: ({ node: _n, ...props }) => <ol className="my-1 list-decimal space-y-0.5 pl-4" {...props} />,
  li: ({ node: _n, ...props }) => <li className="leading-relaxed" {...props} />,
  a: ({ node: _n, children, href, ...props }) => {
    // 引用链接（remarkAiCitations 由 [id=…] 换出）：站内跳页，绝不交给系统浏览器
    const cited = href ? citationViewId(href) : null;
    if (cited) {
      return (
        <a
          href={href}
          title={t("ai.citationOpen")}
          className="mx-0.5 inline-flex max-w-[16rem] items-center gap-1 rounded border border-brand-300 bg-brand-50 px-1 align-baseline text-brand-700 no-underline dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
          onClick={(e) => {
            e.preventDefault();
            openRowInView(cited);
          }}
          {...props}
        >
          <FileText className="h-3 w-3 shrink-0 opacity-70" />
          <span className="truncate">{children}</span>
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-600 underline hover:no-underline dark:text-brand-400"
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          openUrl(href).catch((err: unknown) => toast.error(aiErrorText(err)));
        }}
        {...props}
      >
        {children}
      </a>
    );
  },
  blockquote: ({ node: _n, ...props }) => (
    <blockquote
      className="my-1 border-l-2 border-neutral-300 pl-2 text-neutral-500 dark:border-neutral-600 dark:text-neutral-400"
      {...props}
    />
  ),
  hr: ({ node: _n, ...props }) => <hr className="my-2 border-neutral-200 dark:border-neutral-700" {...props} />,
  pre: ({ node, children, ...props }) => {
    const codeEl = node?.children.find(isHastElement);
    const lang = codeEl ? fenceLang(codeEl.properties.className) : "";
    // mermaid 围栏整块换成图（未加载完/失败时在 MermaidBlock 内退回源码）
    if (lang === "mermaid") return <MermaidBlock code={hastText(codeEl)} />;
    return (
      <pre className={CODE_PRE} {...props}>
        {children}
      </pre>
    );
  },
  code: ({ node, className, children, ...props }) => {
    // 有 language- 前缀的是围栏代码块（外层已有 pre），否则是行内代码
    const lang = fenceLang(className);
    if (lang)
      return (
        <code className="block font-mono text-[11px] leading-relaxed" {...props}>
          <CodeBody lang={lang} code={hastText(node)} />
        </code>
      );
    return (
      <code
        className={cn("rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11px] dark:bg-neutral-700/60", className)}
        {...props}
      >
        {children}
      </code>
    );
  },
  span: ({ node, children, ...props }) => {
    // remarkAiMath 换出的公式占位：class 决定行内/独立，TeX 原文取自身文本
    const cls = classList(props.className);
    if (cls === MATH_CLASS_BLOCK || cls === MATH_CLASS_INLINE) {
      const display = cls === MATH_CLASS_BLOCK;
      return <MathSpan tex={hastText(node)} display={display} />;
    }
    return <span {...props}>{children}</span>;
  },
  table: ({ node: _n, ...props }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: ({ node: _n, ...props }) => (
    <th
      className="border border-neutral-200 bg-neutral-100 px-1.5 py-1 text-left font-medium dark:border-neutral-700 dark:bg-neutral-800"
      {...props}
    />
  ),
  td: ({ node: _n, ...props }) => (
    <td className="border border-neutral-200 px-1.5 py-1 align-top dark:border-neutral-700" {...props} />
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn("break-words text-[12px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkAiCitations, remarkAiMath]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
