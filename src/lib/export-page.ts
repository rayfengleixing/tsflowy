import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
