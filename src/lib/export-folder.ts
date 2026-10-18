import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/invoke";
import type { JSONContent } from "@tiptap/core";
import { useWorkspaceStore } from "@/stores/workspace";
import { collectAssetPaths, copyAssetsForExport, createExportAssetContext } from "./assets";
import { collectDatabaseViewIds, databaseViewToMarkdown } from "./db-transfer";
import { documentApi } from "./documents";
import { EXPORT_MANIFEST_FILE, type ExportManifest } from "./export-manifest";
import { buildFrontmatter } from "./frontmatter";
import { jsonToMarkdown } from "./markdown";
import { logger } from "./logger";
import { sanitizeFileName } from "./utils";
import { parseViewTags, type ViewNode } from "@/types/models";

// 整库导出 Markdown 文件夹（导入 Markdown 文件夹的逆操作）。
//
// 设计：
//   1. 用户选一个目标目录（dialog.open({ directory: true })）。
//   2. 按 workspace 页面树递归导出：
//      - 有子页面的页面 → 同名文件夹（mkdir_all），自身内容写 <页面名>/<页面名>.md；
//      - 叶子文档页 → <页面名>.md；
//      - grid/board/calendar/timeline 页 → 同一路径规则，正文是整张表的 Markdown 表格（含隐藏列），
//        行详情文档作为子页面一并导出；
//      - 每页引用的附件复制到该 md 文件同级的 assets/ 子目录（导出内容里写的就是 assets/xxx 相对路径）。
//   3. 每页头部写 frontmatter（标题/图标/标签/收藏/布局/更新时间），导入时读回（见 import-folder）。
//   4. 写文件走自定义 Rust 命令 write_text_file / mkdir_all（同 CSV 导出），
//      不受 fs 插件 scope 限制。
//   5. 顺序导出（读文档 + 写盘），避免并发写 SQLite 触发 SQLITE_BUSY。
//   6. 根目录再写一份 MANIFEST_FILE：正文里的跨页引用写的是**本库 viewId**
//      （@[标题](view:id)、→[表名](db:id)），换库后这些 id 全部指向不存在的东西。
//      把 viewId → 相对路径 记下来，导入端据此把引用接回新建出来的页面。
//
// 文件名净化：替换 Windows 非法字符、规避保留设备名；同目录重名追加 " (n)"。

export interface ExportFolderResult {
  total: number;
  exported: number;
  failed: number;
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

  // recursive: true 让 dialog 把整棵子树授权给 fs scope：导出会往下建子目录（<页面>/<子页>.md），
  // 非递归时 scope 只放行一层，写入自定义命令会被路径白名单拒绝
  const root = await open({ directory: true, multiple: false, recursive: true });
  if (typeof root !== "string" || !root) return null; // 用户取消

  let total = 0;
  let exported = 0;
  let failed = 0;
  // 同一目录里多页引用同一附件时只复制一次
  const assetCtx = createExportAssetContext();
  /** viewId → 相对导出根目录的 .md 路径，跨库导入时靠它把引用接回（见 MANIFEST_FILE） */
  const refManifest: Record<string, string> = {};

  const writeDoc = async (node: ViewNode, file: string): Promise<void> => {
    total++;
    refManifest[node.id] = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    try {
      const fm = buildFrontmatter({
        title: node.name,
        icon: node.icon ?? undefined,
        layout: node.layout,
        tags: parseViewTags(node.tags),
        favorite: node.is_favorite === 1,
        updatedAtMs: node.updated_at,
      });
      const dir = file.slice(0, file.lastIndexOf("/"));
      let body = "";
      if (node.layout === "document") {
        const raw = await documentApi.get(node.id);
        const doc = raw ? parseDoc(raw) : null;
        if (doc) {
          // 内嵌数据库块：正文只留 db: 指针的话，导出的库在别人手里就是一行链接。
          // jsonToMarkdown 是同步的，所以先异步把引用到的表取成文本再传入。
          const tables: Record<string, string> = {};
          for (const viewId of collectDatabaseViewIds(doc)) {
            try {
              tables[viewId] = await databaseViewToMarkdown(viewId, false);
            } catch (e) {
              logger.warn("export-folder", "embedded database table export failed", viewId, e);
            }
          }
          body = jsonToMarkdown(doc, { databaseTables: tables });
          await copyAssetsForExport(collectAssetPaths(doc), dir, assetCtx);
        }
      } else {
        // 数据库页：整表（含隐藏列）落盘，行详情文档由树遍历当子页面处理
        body = await databaseViewToMarkdown(node.id, true);
        if (body) body = `# ${node.name}\n\n${body}\n`;
      }
      await invoke<void>("write_text_file", { path: file, content: fm + body });
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
      const base = uniqueName(sanitizeFileName(node.name));
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
  // 清单写在最后：中途失败时不会留下一个声称"全部导出成功"的半截清单
  await invoke<void>("write_text_file", {
    path: `${root}/${EXPORT_MANIFEST_FILE}`,
    content: JSON.stringify({ version: 1, views: refManifest } satisfies ExportManifest),
  });
  return { total, exported, failed };
}
