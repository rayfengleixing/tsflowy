import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";
import { useWorkspaceStore } from "@/stores/workspace";
import { documentApi } from "./documents";
import { jsonToMarkdown } from "./markdown";
import { logger } from "./logger";
import type { ViewNode } from "@/types/models";

// 整库导出 Markdown 文件夹（导入 Markdown 文件夹的逆操作）。
//
// 设计：
//   1. 用户选一个目标目录（dialog.open({ directory: true })）。
//   2. 按 workspace 页面树递归导出：
//      - 有子页面的页面 → 同名文件夹（mkdir_all），自身内容写 <页面名>/<页面名>.md；
//      - 叶子文档页 → <页面名>.md；
//      - grid/board/calendar 页无文档内容，叶子跳过、有子页面时仅作文件夹容器。
//   3. 写文件走自定义 Rust 命令 write_text_file / mkdir_all（同 CSV 导出），
//      不受 fs 插件 scope 限制。
//   4. 顺序导出（读文档 + 写盘），避免并发写 SQLite 触发 SQLITE_BUSY。
//
// 文件名净化：替换 Windows 非法字符、规避保留设备名；同目录重名追加 " (n)"。

export interface ExportFolderResult {
  total: number;
  exported: number;
  failed: number;
}

/** 页面名 → 合法文件名（不含扩展名） */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned) return "_";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

/** 与 exportPage 相同的解析规则：非 JSON 纯文本按单段落包装 */
function parseDoc(raw: string): JSONContent {
  let json: JSONContent;
  try {
    json = JSON.parse(raw) as JSONContent;
  } catch {
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }] };
  }
  return Array.isArray(json) ? { type: "doc", content: json } : json;
}

export async function exportMarkdownFolder(): Promise<ExportFolderResult | null> {
  const tree = useWorkspaceStore.getState().tree;
  if (tree.length === 0) return { total: 0, exported: 0, failed: 0 };

  const root = await open({ directory: true, multiple: false });
  if (typeof root !== "string" || !root) return null; // 用户取消

  let total = 0;
  let exported = 0;
  let failed = 0;

  const writeDoc = async (node: ViewNode, file: string): Promise<void> => {
    if (node.layout !== "document") return; // 非文档布局无 Markdown 内容
    total++;
    try {
      const raw = await documentApi.get(node.id);
      const md = raw ? jsonToMarkdown(parseDoc(raw)) : "";
      await invoke<void>("write_text_file", { path: file, content: md });
      exported++;
    } catch (e) {
      failed++;
      logger.warn("export-folder", "export one page failed", node.name, e);
    }
  };

  const walk = async (nodes: ViewNode[], dir: string): Promise<void> => {
    const used = new Map<string, number>();
    const uniqueName = (base: string): string => {
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      return n === 0 ? base : `${base} (${n + 1})`;
    };
    for (const node of nodes) {
      const isBranch = node.children.length > 0;
      if (node.layout !== "document" && !isBranch) continue; // 无内容叶子直接跳过
      const base = uniqueName(sanitizeName(node.name));
      if (isBranch) {
        const sub = `${dir}/${base}`;
        await invoke<void>("mkdir_all", { path: sub });
        await writeDoc(node, `${sub}/${base}.md`);
        await walk(node.children, sub);
      } else {
        await writeDoc(node, `${dir}/${base}.md`);
      }
    }
  };

  await walk(tree, root);
  return { total, exported, failed };
}
