// mermaid 图表渲染（编辑器 NodeView 与 AI 面板共用一份，安全配置不各写一遍）
// 核心约 800KB，只有页面真正出现图表时才按需加载并缓存。
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  return (mermaidPromise ??= import("mermaid").then((m) => m.default));
}

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

/** 渲染一段 mermaid 源码为 SVG 字符串；语法有错时 reject（错误文案由调用方展示） */
export async function renderMermaid(code: string): Promise<string> {
  const dark = document.documentElement.classList.contains("dark");
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    // 必须 strict：loose 会让 mermaid 跳过对输出 SVG 的 DOMPurify 清洗，
    // 渲染结果又直接进 dangerouslySetInnerHTML，导入不可信内容即可执行脚本。
    // securityLevel 在 mermaid 的 secure 白名单里，图表内 %%{init}%% 覆盖不了它。
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "inherit",
  });
  const id = `mmd-${++renderSeq}`;
  try {
    // 语法预校验：失败直接抛给上层显示，不进 render——
    // mermaid v12 的 render 失败时会把错误内容留在 body 末尾的临时元素里，
    // 表现为「错误提示显示在整个应用界面之外」
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code, getRenderHost());
    return svg;
  } finally {
    // 兜底清理：render 成功/失败后残留的临时元素一并移除（#<id> 与带 d 前缀的变体）
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
