// KaTeX 渲染（编辑器公式块与 AI 面板共用一份配置）
// CSS 静态引入（约 20KB）避免公式加载过程中出现无样式闪烁；核心约 580KB，首次用到时才按需加载并缓存
import "katex/dist/katex.min.css";

let katexPromise: Promise<typeof import("katex").default> | null = null;

function loadKatex() {
  return (katexPromise ??= import("katex").then((m) => m.default));
}

/** 渲染失败时 katex 自己会画红色错误，但加载/极端输入仍可能抛，兜底成可读文本 */
export const INVALID_TEX_HTML = `<span style="color:#d92d20">Invalid TeX</span>`;

/** 把 TeX 渲染成 HTML 字符串；renderToString 只输出 katex 自己的标记，不透传输入里的原始 HTML */
export async function renderTex(tex: string, displayMode: boolean): Promise<string> {
  try {
    const katex = await loadKatex();
    return katex.renderToString(tex, { throwOnError: false, displayMode });
  } catch {
    return INVALID_TEX_HTML;
  }
}
