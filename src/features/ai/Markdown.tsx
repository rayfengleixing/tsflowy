import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { aiErrorText } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * AI 回复的 Markdown 渲染（GFM：表格/任务列表/删除线/自动链接）。
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
  a: ({ node: _n, children, href, ...props }) => (
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
  ),
  blockquote: ({ node: _n, ...props }) => (
    <blockquote
      className="my-1 border-l-2 border-neutral-300 pl-2 text-neutral-500 dark:border-neutral-600 dark:text-neutral-400"
      {...props}
    />
  ),
  hr: ({ node: _n, ...props }) => <hr className="my-2 border-neutral-200 dark:border-neutral-700" {...props} />,
  pre: ({ node: _n, ...props }) => (
    <pre
      className="my-1.5 overflow-x-auto rounded-md bg-neutral-200/60 p-2 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
      {...props}
    />
  ),
  code: ({ node: _n, className, children, ...props }) =>
    // 有 language- 前缀的是围栏代码块（外层已有 pre），否则是行内代码
    typeof className === "string" && className.includes("language-") ? (
      <code className="block font-mono text-[11px] leading-relaxed" {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11px] dark:bg-neutral-700/60" {...props}>
        {children}
      </code>
    ),
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
