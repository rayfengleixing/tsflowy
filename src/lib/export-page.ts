import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useEditorStore } from "@/stores/editor";
import { flushAllForClose } from "./close-flush";
import { t } from "./i18n";
import { collectAssetPaths, copyAssetsForExport, isLibraryAssetPath } from "./assets";
import { attachmentKindOf } from "./attachment-kind";
import { databaseApi } from "./database";
import { tableToTextMatrix, toMarkdownTable } from "./db-transfer";
import { viewApi } from "./db";
import { documentApi } from "./documents";
import { alignValueOf, calloutColorOf, columnRatioOf, jsonToMarkdown } from "./markdown";
import { logger } from "./logger";
import { sanitizeFileName } from "./utils";
import { dueState, taskMetaLabel, taskMetaOf, todayIso } from "./task-meta";

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
      if (child.type === "mention") return `[[${attrStr(child, "label") || attrStr(child, "id")}]]`;
      return textOf(child);
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 取字符串属性（attrs 是 unknown 值域，先做类型收窄再进模板串） */
function attrStr(node: { attrs?: Record<string, unknown> }, key: string): string {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : "";
}

function firstNonEmpty(...vals: string[]): string {
  return vals.find((v) => v !== "") ?? "";
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
  .math { text-align: center; font-family: "Cambria Math", Georgia, serif; font-size: 1.1em; margin: 1em 0; }
  .mermaid { background: #fafafa; border: 1px dashed #ddd; }
  .attachment a { display: inline-block; border: 1px solid #ddd; border-radius: 8px; padding: 8px 12px; text-decoration: none; color: #333; }
  .attachment audio, .attachment video, .attachment img.attachment-image { display: block; max-width: 100%; margin-top: 8px; }
  .attachment iframe { display: block; width: 100%; height: 640px; margin-top: 8px; border: 1px solid #ddd; border-radius: 6px; background: #fff; }
  .database-view { border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 14px; color: #666; background: #fafafa; }
  .mention { color: #2563eb; }
  details { border: 1px solid #eee; border-radius: 6px; padding: 8px 12px; margin: 1em 0; }
  summary { cursor: pointer; font-weight: 600; }
  aside.callout { display: flex; gap: 10px; border-left: 3px solid #93c5fd; background: #eff6ff; padding: 10px 14px; border-radius: 6px; }
  aside.callout-green { border-left-color: #86efac; background: #f0fdf4; }
  aside.callout-orange { border-left-color: #fdba74; background: #fff7ed; }
  aside.callout-red { border-left-color: #fca5a5; background: #fef2f2; }
  aside.callout-purple { border-left-color: #c4b5fd; background: #faf5ff; }
  aside.callout-yellow { border-left-color: #fde047; background: #fefce8; }
  .callout-emoji { flex: none; }
  .columns { display: flex; gap: 20px; align-items: flex-start; }
  .columns > .column { flex: 1 1 0; min-width: 0; }
  .gallery { display: flex; flex-wrap: wrap; gap: 8px; }
  .gallery img { max-height: 240px; border-radius: 6px; }
  ul.task-list { list-style: none; }
  .task-meta { margin-left: 8px; padding: 1px 8px; border-radius: 999px; font-size: 0.8em; white-space: nowrap; color: #475467; background: #f2f4f7; }
  .task-meta-today { color: #b54708; background: #fffaeb; }
  .task-meta-overdue { color: #d92d20; background: #fee9e9; }
</style></head>
<body>${body}</body></html>`;
}

/** 任务行 chip（截止日期 / 负责人）：文案与状态口径都取自 lib/task-meta，编辑器与导出一致 */
function taskMetaChipHtml(attrs: Record<string, unknown> | undefined): string {
  const meta = taskMetaOf(attrs);
  const label = taskMetaLabel(meta);
  if (!label) return "";
  const state = meta.due ? dueState(meta.due, todayIso()) : null;
  const cls = state ? `task-meta task-meta-${state}` : "task-meta";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

/** 附件预览：图片 / 音频 / 视频 / PDF 在导出页里直接可看可播，其余类型仍只是下载链接。
 *  只嵌库内相对路径与 http(s)——绝对本地路径在别人机器上指向不了任何东西，嵌进去只剩一个报错的黑框。 */
function attachmentPreviewHtml(node: JSONContent, rawSrc: string): string {
  if (!(isLibraryAssetPath(rawSrc) || /^https?:\/\//i.test(rawSrc))) return "";
  const kind = attachmentKindOf(attrStr(node, "name"), rawSrc);
  if (kind === "other") return "";
  const href = escapeAttr(rawSrc);
  const label = escapeAttr(attrStr(node, "name") || rawSrc);
  switch (kind) {
    case "image":
      return `<img class="attachment-image" src="${href}" alt="${label}"/>`;
    case "audio":
      return `<audio class="attachment-audio" controls src="${href}"></audio>`;
    case "video":
      return `<video class="attachment-video" controls preload="metadata" src="${href}"></video>`;
    case "pdf":
      return `<iframe class="attachment-pdf" title="${label}" src="${href}"></iframe>`;
  }
}

/** 块级对齐写进 inline style（值已由 alignValueOf 白名单过滤，不需要再转义） */
function alignAttr(node: JSONContent): string {
  const align = alignValueOf(node);
  return align ? ` style="text-align:${align}"` : "";
}

function nodeToHtml(node: JSONContent): string {
  switch (node.type) {
    case "heading": {
      // 存下来的 JSON 可能来自别的编辑器：夹进 h1–h6，否则拼出 <h0>/<h7> 这种无效标签
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `<h${level}${alignAttr(node)}>${inlineHtml(node)}</h${level}>`;
    }
    case "paragraph":
      return `<p${alignAttr(node)}>${inlineHtml(node)}</p>`;
    case "codeBlock": {
      const lang = (node.attrs?.language as string) || "";
      return `<pre><code class="language-${escapeAttr(lang)}">${escapeHtml(textOf(node))}</code></pre>`;
    }
    case "image": {
      const src = escapeAttr(attrStr(node, "src"));
      const alt = escapeHtml(attrStr(node, "alt"));
      const captionText = attrStr(node, "caption");
      const caption = captionText ? `<figcaption>${escapeHtml(captionText)}</figcaption>` : "";
      return `<figure><img src="${src}" alt="${alt}"/>${caption}</figure>`;
    }
    case "taskList":
      return `<ul class="task-list">${(node.content ?? [])
        .map(
          (c) =>
            `<li><input type="checkbox" ${c.attrs?.checked ? "checked" : ""} disabled/> ${inlineHtml(c)}${taskMetaChipHtml(
              c.attrs,
            )}</li>`,
        )
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
    case "math": {
      // 导出文件不加载 KaTeX，直接输出 TeX 源码（居中衬线体，语义可读不丢失）
      return `<div class="math">${escapeHtml(attrStr(node, "tex"))}</div>`;
    }
    case "mermaid": {
      // 用 <pre class="mermaid"> 保留源码：页面不引 mermaid.js 时按代码块展示，引了即可渲染
      return `<pre class="mermaid">${escapeHtml(attrStr(node, "code"))}</pre>`;
    }
    case "attachment": {
      const rawSrc = attrStr(node, "src");
      const src = escapeAttr(rawSrc);
      const name = escapeHtml(firstNonEmpty(attrStr(node, "name"), rawSrc, t("attachment.defaultName")));
      return `<p class="attachment"><a href="${src}">${name}</a>${attachmentPreviewHtml(node, rawSrc)}</p>`;
    }
    case "databaseView": {
      const name = escapeHtml(firstNonEmpty(attrStr(node, "name"), t("databaseView.defaultName")));
      return `<div class="database-view">${name}</div>`;
    }
    case "toggle": {
      const blocks = node.content ?? [];
      const first = blocks.length > 0 ? blocks[0] : undefined;
      const firstIsTitle = first?.type === "paragraph" || first?.type === "heading";
      const title = first && firstIsTitle ? inlineHtml(first) : "";
      const body = (firstIsTitle ? blocks.slice(1) : blocks).map(nodeToHtml).join("");
      return `<details${node.attrs?.collapsed ? "" : " open"}><summary>${title}</summary>${body}</details>`;
    }
    case "callout": {
      const emoji = escapeHtml(firstNonEmpty(attrStr(node, "emoji"), "💡"));
      // 色名走 markdown.ts 同一份白名单，导出只加 class，颜色由 <style> 决定
      const inner = (node.content ?? []).map(nodeToHtml).join("");
      return `<aside class="callout callout-${calloutColorOf(node)}"><span class="callout-emoji">${emoji}</span>${inner}</aside>`;
    }
    case "columns": {
      // 列宽跟随 column.ratio（静态导出也要保持用户拖出来的比例）
      const cols = (node.content ?? []).map(
        (col) =>
          `<div class="column" style="flex:${columnRatioOf(col)} 1 0%">${(col.content ?? [])
            .map(nodeToHtml)
            .join("")}</div>`,
      );
      return `<div class="columns">${cols.join("")}</div>`;
    }
    case "imageGallery": {
      const imgs = (node.content ?? [])
        .map((img) => `<img src="${escapeAttr(attrStr(img, "src"))}" alt="${escapeHtml(attrStr(img, "alt"))}"/>`)
        .join("");
      return `<div class="gallery">${imgs}</div>`;
    }
    case "outline":
      // 大纲是编辑辅助块，导出时省略
      return "";
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
            else if (m.type === "link") html = `<a href="${escapeAttr(attrStr(m, "href"))}">${html}</a>`;
            else if (m.type === "underline") html = `<u>${html}</u>`;
          }
        }
        return html;
      }
      if (child.type === "hardBreak") return "<br/>";
      if (child.type === "mention")
        return `<a class="mention" href="#">[[${escapeHtml(attrStr(child, "label") || attrStr(child, "id"))}]]</a>`;
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
      // 合并单元格：模型里被覆盖的位置没有节点，所以只要把 colspan/rowspan 写出来就是对的表
      const span = (key: "colspan" | "rowspan") => {
        const v = Number(cell.attrs?.[key] ?? 1);
        return v > 1 ? ` ${key}="${Math.floor(v)}"` : "";
      };
      html += `<${tag}${span("colspan")}${span("rowspan")}>${inlineHtml(cell)}</${tag}>`;
    }
    html += "</tr>";
  });
  html += "</table>";
  return html;
}

/** 数据库页（grid/board/calendar/timeline）的整表导出。
 *  返回 false 表示这不是数据库页（调用方继续按文档处理）；返回 true 表示本次导出已收尾（含用户取消）。 */
async function exportDatabasePage(viewId: string, viewName: string, format: "markdown" | "html"): Promise<boolean> {
  const view = await viewApi.get(viewId);
  if (!view || view.layout === "document") return false;
  const [fields, rows, cells] = await Promise.all([
    databaseApi.listFields(viewId),
    databaseApi.listRows(viewId),
    databaseApi.loadCells(viewId),
  ]);
  if (fields.length === 0) return false;
  // 整表导出含隐藏列：这是数据出口，不是界面复刻
  const matrix = tableToTextMatrix(fields, rows, cells, true);
  const ext = format === "markdown" ? "md" : "html";
  const body =
    format === "markdown"
      ? `# ${viewName}\n\n${toMarkdownTable(matrix)}\n`
      : `<h1>${escapeHtml(viewName)}</h1>\n<table>\n` +
        matrix
          .map(
            (row, i) =>
              `<tr>${row.map((c) => `<${i === 0 ? "th" : "td"}>${escapeHtml(c)}</${i === 0 ? "th" : "td"}>`).join("")}</tr>`,
          )
          .join("\n") +
        "\n</table>\n";

  const target = await save({
    defaultPath: `${viewName}.${ext}`,
    filters: [{ name: format === "markdown" ? "Markdown" : "HTML", extensions: [ext] }],
  });
  if (!target) return true;
  await writeTextFile(target, body);
  return true;
}

export async function exportPage(viewId: string, viewName: string, format: "markdown" | "html"): Promise<void> {
  // 打开的文档可能还有防抖窗口（800ms）内未落库的改动：先冲刷挂起写，否则导出的是库里的旧内容
  await flushAllForClose();
  const raw = await documentApi.get(viewId);
  if (!raw) {
    // 数据库页没有文档正文：导出整张表，否则「导出此页」对 grid/board/calendar/timeline 永远只有一句空文档警告
    if (await exportDatabasePage(viewId, viewName, format)) return;
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
  const assetPaths = collectAssetPaths(doc);

  // 带附件时导出到目录：导出内容写的是 assets/xxx 相对路径，附件必须落到同一个目录下才点得开。
  // 保存对话框只授权它返回的那个文件路径本身，同级 assets/ 要靠目录对话框（recursive）授权。
  if (assetPaths.length > 0) {
    const dir = await open({ directory: true, multiple: false, recursive: true });
    if (typeof dir !== "string" || !dir) return;
    const file = `${dir}/${sanitizeFileName(viewName)}.${ext}`;
    await writeTextFile(file, content);
    await copyAssetsForExport(assetPaths, dir);
    return;
  }

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
  // html-to-image 体积可观且仅在长图导出时用到：按需加载，避免进主包/拖慢启动
  const { toBlob } = await import("html-to-image");
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
  /* 分页控制：整块内容不被拦腰截断；标题不与其后的正文分离；长表格跨页时重复表头 */
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} img,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} figure,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} table,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} tr,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} pre,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} blockquote,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} li {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h1,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h2,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h3,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h4,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h5,
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} h6 {
    break-after: avoid;
    page-break-after: avoid;
  }
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} p { orphans: 2; widows: 2; }
  body.${PRINTING_CLASS} .${PRINT_ROOT_CLASS} thead { display: table-header-group; }
}
`;
  document.head.appendChild(style);
}
