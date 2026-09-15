import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { toBlob } from "html-to-image";
import { toast } from "sonner";
import { useEditorStore } from "@/stores/editor";
import { t } from "./i18n";
import { documentApi } from "./documents";
import { jsonToMarkdown } from "./markdown";
import { logger } from "./logger";

interface JSONContent {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** 递归提取 node 的纯文本（HTML 导出用：codeBlock 内容需 escape 后输出） */
function textOf(node: JSONContent): string {
  if (!node.content) return "";
  return node.content
    .map((child) => {
      if (child.type === "text") return child.text ?? "";
      if (child.type === "hardBreak") return "\n";
      if (child.type === "mention") return `[[${child.attrs?.label ?? child.attrs?.id ?? ""}]]`;
      return textOf(child);
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 转义 HTML 属性值（src/href 等），防止 `"` 与 `javascript:` 破坏标签或触发 XSS */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** TipTap JSON → HTML（自包含，不依赖 TipTap extensions 实例） */
function jsonToHTML(nodes: JSONContent[], title: string): string {
  const body = nodes.map(nodeToHtml).join("");
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  body { max-width: 800px; margin: 40px auto; font-family: -apple-system, "Segoe UI", sans-serif; line-height: 1.7; color: #333; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 16px; overflow-x: auto; }
  code { font-family: "JetBrains Mono", monospace; font-size: 0.9em; }
  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 16px; color: #666; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 6px 12px; }
  img { max-width: 100%; }
</style></head>
<body>${body}</body></html>`;
}

function nodeToHtml(node: JSONContent): string {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level) || 1;
      return `<h${level}>${inlineHtml(node)}</h${level}>`;
    }
    case "paragraph":
      return `<p>${inlineHtml(node)}</p>`;
    case "codeBlock": {
      const lang = (node.attrs?.language as string) || "";
      return `<pre><code class="language-${escapeAttr(lang)}">${escapeHtml(textOf(node))}</code></pre>`;
    }
    case "image": {
      const src = escapeAttr(String(node.attrs?.src ?? ""));
      const alt = escapeHtml(String(node.attrs?.alt ?? ""));
      const caption = node.attrs?.caption ? `<figcaption>${escapeHtml(String(node.attrs.caption))}</figcaption>` : "";
      return `<figure><img src="${src}" alt="${alt}"/>${caption}</figure>`;
    }
    case "taskList":
      return `<ul class="task-list">${(node.content ?? [])
        .map((c) => `<li><input type="checkbox" ${c.attrs?.checked ? "checked" : ""} disabled/> ${inlineHtml(c)}</li>`)
        .join("")}</ul>`;
    case "bulletList":
      return `<ul>${(node.content ?? []).map((c) => `<li>${inlineHtml(c)}</li>`).join("")}</ul>`;
    case "orderedList":
      return `<ol>${(node.content ?? []).map((c) => `<li>${inlineHtml(c)}</li>`).join("")}</ol>`;
    case "blockquote":
      return `<blockquote>${(node.content ?? []).map(nodeToHtml).join("")}</blockquote>`;
    case "horizontalRule":
      return `<hr/>`;
    case "table":
      return renderTableHtml(node);
    default:
      return inlineHtml(node);
  }
}

function inlineHtml(node: JSONContent): string {
  if (!node.content) return "";
  return node.content
    .map((child) => {
      if (child.type === "text") {
        let html = escapeHtml(child.text ?? "");
        if (child.marks) {
          for (const m of child.marks) {
            if (m.type === "bold") html = `<strong>${html}</strong>`;
            else if (m.type === "italic") html = `<em>${html}</em>`;
            else if (m.type === "code") html = `<code>${html}</code>`;
            else if (m.type === "strike") html = `<del>${html}</del>`;
            else if (m.type === "link") html = `<a href="${escapeAttr(String(m.attrs?.href ?? ""))}">${html}</a>`;
            else if (m.type === "underline") html = `<u>${html}</u>`;
          }
        }
        return html;
      }
      if (child.type === "hardBreak") return "<br/>";
      if (child.type === "mention")
        return `<a class="mention" href="#">[[${escapeHtml(String(child.attrs?.label ?? child.attrs?.id ?? ""))}]]</a>`;
      return nodeToHtml(child);
    })
    .join("");
}

function renderTableHtml(node: JSONContent): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return "";
  const isHeader = rows[0]?.type === "tableRow";
  let html = "<table>";
  rows.forEach((row, i) => {
    html += "<tr>";
    for (const cell of row.content ?? []) {
      const tag = i === 0 && isHeader ? "th" : "td";
      html += `<${tag}>${inlineHtml(cell)}</${tag}>`;
    }
    html += "</tr>";
  });
  html += "</table>";
  return html;
}

export async function exportPage(viewId: string, viewName: string, format: "markdown" | "html"): Promise<void> {
  const raw = await documentApi.get(viewId);
  if (!raw) {
    logger.warn("export-page", "document content is empty", viewId);
    return;
  }

  let json: JSONContent;
  try {
    json = JSON.parse(raw) as JSONContent;
  } catch {
    // 非 JSON（纯文本），按单段落包装成 doc
    json = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }] };
  }

  // 兼容旧调用：若解析出的是数组，包装成 doc；否则直接用
  const doc: JSONContent = Array.isArray(json) ? { type: "doc", content: json } : json;

  const ext = format === "markdown" ? "md" : "html";
  // Markdown：复用 markdown.ts 的 jsonToMarkdown（支持 callout/toggle/columns/math 等高级块）
  // HTML：用本地 jsonToHTML（自包含样式，补 escape 防 XSS）
  const content = format === "markdown" ? jsonToMarkdown(doc) : jsonToHTML(doc.content ?? [], viewName);

  const target = await save({
    defaultPath: `${viewName}.${ext}`,
    filters: [{ name: format === "markdown" ? "Markdown" : "HTML", extensions: [ext] }],
  });
  if (!target) return;

  await writeTextFile(target, content);
}

// ————————————————————————————————————————————————
// 当前页导出：长图（PNG）与 PDF（打印）
// ————————————————————————————————————————————————

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 长图四周留白（px） */
const IMAGE_PAD = 32;
/** canvas 单边像素上限（Chromium 硬限制约 16384，超出会被静默压缩） */
const CANVAS_MAX = 16000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read blob failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 把编辑器里 assets/ 图片临时替换为 data URL（返回恢复函数）。
 * html-to-image 抓跨源图片：能抓到也可能污染 canvas（toBlob 抛 SecurityError），
 * 抓不到则直接丢图——都不如走 Rust 读文件稳定（路径越权校验也在 Rust 侧）。
 */
async function inlineAssetImages(root: HTMLElement): Promise<() => void> {
  const restores: (() => void)[] = [];
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-asset-path]"));
  for (const img of imgs) {
    const relative = img.getAttribute("data-asset-path") ?? "";
    const original = img.getAttribute("src") ?? "";
    if (!relative || original.startsWith("data:")) continue;
    try {
      const bytes = await invoke<number[]>("read_asset_bytes", { relative });
      const ext = relative.split(".").pop()?.toLowerCase() ?? "";
      const blob = new Blob([new Uint8Array(bytes)], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" });
      img.setAttribute("src", await blobToDataUrl(blob));
      restores.push(() => img.setAttribute("src", original));
    } catch (e) {
      logger.warn("export-page", `inline asset failed: ${relative}`, e);
    }
  }
  return () => {
    for (const restore of restores) restore();
  };
}

/** 向上找最近的非透明背景色，作为长图画布底色（深色主题下不做处理会出白底浅字） */
function resolveBackdrop(node: HTMLElement): string {
  let cur: HTMLElement | null = node;
  while (cur) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg;
    cur = cur.parentElement;
  }
  return "#ffffff";
}

/**
 * 长图导出：把当前文档的编辑器 DOM 渲染为一张完整 PNG 并写盘。
 * 需要活的编辑器实例（TabBar 仅在有打开文档时展示入口）。
 */
export async function exportPageImage(viewName: string): Promise<void> {
  const editor = useEditorStore.getState().editor;
  if (!editor || editor.isDestroyed) throw new Error("editor not ready");

  const el = editor.view.dom;
  const restore = await inlineAssetImages(el);
  let blob: Blob | null = null;
  try {
    const width = el.scrollWidth;
    const height = el.scrollHeight;
    const backdrop = resolveBackdrop(el);
    const ratio = Math.min(2, CANVAS_MAX / Math.max(width, height, 1));
    const options = {
      width: width + IMAGE_PAD * 2,
      height: height + IMAGE_PAD * 2,
      pixelRatio: ratio,
      backgroundColor: backdrop,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        padding: `${IMAGE_PAD}px`,
        boxSizing: "content-box" as const,
      },
    };
    try {
      blob = await toBlob(el, options);
    } catch (e) {
      // 内嵌字体/外部资源个别失败时降级跳过字体再试一次（保底出图）
      logger.warn("export-page.image", "toBlob failed, retry with skipFonts", e);
      blob = await toBlob(el, { ...options, skipFonts: true });
    }
  } finally {
    restore();
  }
  if (!blob) throw new Error("empty canvas");

  const target = await save({
    defaultPath: `${viewName}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!target) return;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await invoke("write_binary_file", { path: target, bytes: Array.from(bytes) });
  toast.success(t("settings.exportedFile", { path: target }));
}

const PRINT_STYLE_ID = "tsflowy-print-style";
const PRINT_ROOT_CLASS = "tsflowy-print-root";
const PRINTING_CLASS = "tsflowy-printing";

/**
 * PDF 导出（系统打印 → 另存为 PDF）：把编辑器 DOM 克隆到 body 级容器，
 * 打印样式只显示该容器。克隆而非直接打印原 DOM：编辑器被多层 overflow-hidden
 * 祖先约束（固定高度滚动容器），直接打印会被裁成一屏。
 */
export async function printPage(): Promise<void> {
  const editor = useEditorStore.getState().editor;
  if (!editor || editor.isDestroyed) throw new Error("editor not ready");

  ensurePrintStyle();

  const portal = document.createElement("div");
  portal.className = PRINT_ROOT_CLASS;
  const clone = editor.view.dom.cloneNode(true) as HTMLElement;
  // 打印只保留正文：去掉节点视图按钮（删除/放大等）与空段落占位标记
  clone.querySelectorAll("button").forEach((b) => b.remove());
  clone.querySelectorAll(".is-empty").forEach((e) => e.classList.remove("is-empty"));
  portal.appendChild(clone);
  document.body.appendChild(portal);
  document.body.classList.add(PRINTING_CLASS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("afterprint", cleanup);
    document.body.classList.remove(PRINTING_CLASS);
    portal.remove();
  };
  window.addEventListener("afterprint", cleanup);
  try {
    // 等一帧确保 portal 完成布局，再唤起打印预览
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.print();
  } finally {
    // afterprint 部分实现不触发：兜底清理（打印预览此刻已取过内容快照，安全）
    window.setTimeout(cleanup, 10_000);
  }
}

function ensurePrintStyle() {
  if (document.getElementById(PRINT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PRINT_STYLE_ID;
  style.textContent = `
.${PRINT_ROOT_CLASS} { display: none; }
@page { margin: 14mm; }
@media print {
  body.${PRINTING_CLASS} > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }
  body.${PRINTING_CLASS} > .${PRINT_ROOT_CLASS} { display: block !important; }
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} .tiptap { max-width: none !important; outline: none !important; }
}
`;
  document.head.appendChild(style);
}
