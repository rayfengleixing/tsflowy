import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { documentApi } from "./documents";
import { logger } from "./logger";

type JSONContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

/** 递归提取 node 的纯文本 */
function textOf(node: JSONContent): string {
  if (!node.content) return "";
  return node.content
    .map((child) => {
      if (child.type === "text") {
        let text = child.text ?? "";
        if (child.marks) {
          for (const m of child.marks) {
            if (m.type === "bold") text = `**${text}**`;
            else if (m.type === "italic") text = `*${text}*`;
            else if (m.type === "code") text = `\`${text}\``;
            else if (m.type === "strike") text = `~~${text}~~`;
            else if (m.type === "link") text = `[${text}](${m.attrs?.href ?? ""})`;
          }
        }
        return text;
      }
      if (child.type === "hardBreak") return "\n";
      if (child.type === "mention") return `[[${child.attrs?.label ?? child.attrs?.id ?? ""}]]`;
      return textOf(child);
    })
    .join("");
}

/** TipTap JSON → Markdown */
function jsonToMarkdown(nodes: JSONContent[]): string {
  const out: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        out.push(`${"#".repeat(Number(node.attrs?.level) || 1)} ${textOf(node)}\n`);
        break;
      case "paragraph":
        out.push(`${textOf(node)}\n`);
        break;
      case "codeBlock": {
        const lang = (node.attrs?.language as string) || "";
        out.push(`\`\`\`${lang}\n${textOf(node)}\n\`\`\`\n`);
        break;
      }
      case "image":
        out.push(`![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n`);
        break;
      case "taskList":
        for (const child of node.content ?? []) {
          const checked = child.attrs?.checked ? "x" : " ";
          out.push(`- [${checked}] ${textOf(child)}\n`);
        }
        break;
      case "bulletList":
        for (const child of node.content ?? []) out.push(`- ${textOf(child)}\n`);
        break;
      case "orderedList": {
        let i = 1;
        for (const child of node.content ?? []) out.push(`${i++}. ${textOf(child)}\n`);
        break;
      }
      case "blockquote":
        for (const child of node.content ?? []) out.push(`> ${textOf(child)}\n`);
        break;
      case "horizontalRule":
        out.push("---\n");
        break;
      default:
        out.push(`${textOf(node)}\n`);
    }
  }
  return out.join("\n").trim() + "\n";
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nodeToHtml(node: JSONContent): string {
  switch (node.type) {
    case "heading":
      return `<h${node.attrs?.level}>${inlineHtml(node)}</h${node.attrs?.level}>`;
    case "paragraph":
      return `<p>${inlineHtml(node)}</p>`;
    case "codeBlock": {
      const lang = (node.attrs?.language as string) || "";
      return `<pre><code class="language-${lang}">${escapeHtml(textOf(node))}</code></pre>`;
    }
    case "image":
      return `<figure><img src="${node.attrs?.src}" alt="${node.attrs?.alt ?? ""}"/>` +
        (node.attrs?.caption ? `<figcaption>${escapeHtml(String(node.attrs.caption))}</figcaption>` : "") + `</figure>`;
    case "taskList":
      return `<ul class="task-list">${(node.content ?? []).map(c =>
        `<li><input type="checkbox" ${c.attrs?.checked ? "checked" : ""} disabled/> ${inlineHtml(c)}</li>`
      ).join("")}</ul>`;
    case "bulletList":
      return `<ul>${(node.content ?? []).map(c => `<li>${inlineHtml(c)}</li>`).join("")}</ul>`;
    case "orderedList":
      return `<ol>${(node.content ?? []).map(c => `<li>${inlineHtml(c)}</li>`).join("")}</ol>`;
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
  return node.content.map((child) => {
    if (child.type === "text") {
      let html = escapeHtml(child.text ?? "");
      if (child.marks) {
        for (const m of child.marks) {
          if (m.type === "bold") html = `<strong>${html}</strong>`;
          else if (m.type === "italic") html = `<em>${html}</em>`;
          else if (m.type === "code") html = `<code>${html}</code>`;
          else if (m.type === "strike") html = `<del>${html}</del>`;
          else if (m.type === "link") html = `<a href="${m.attrs?.href}">${html}</a>`;
          else if (m.type === "underline") html = `<u>${html}</u>`;
        }
      }
      return html;
    }
    if (child.type === "hardBreak") return "<br/>";
    if (child.type === "mention") return `<a class="mention" href="#">[[${child.attrs?.label ?? child.attrs?.id}]]</a>`;
    return nodeToHtml(child);
  }).join("");
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

  let json: JSONContent[];
  try {
    json = JSON.parse(raw);
  } catch {
    // 非 JSON（纯文本），按单段落处理
    json = [{ type: "paragraph", content: [{ type: "text", text: raw }] }];
  }

  const ext = format === "markdown" ? "md" : "html";
  const content = format === "markdown" ? jsonToMarkdown(json) : jsonToHTML(json, viewName);

  const target = await save({
    defaultPath: `${viewName}.${ext}`,
    filters: [{ name: format === "markdown" ? "Markdown" : "HTML", extensions: [ext] }],
  });
  if (!target) return;

  await writeTextFile(target, content);
}
