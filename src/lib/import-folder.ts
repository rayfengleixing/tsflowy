import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, type DirEntry } from "@tauri-apps/plugin-fs";
import { viewApi } from "./db";
import { documentApi } from "./documents";
import { markdownToJson } from "./markdown";
import { logger } from "./logger";

// 导入 Markdown 文件夹（Phase 4.1 导入体系）。
//
// 设计：
//   1. 用户选一个目录（dialog.open({ directory: true })）。
//   2. 递归遍历收集所有 .md 文件（relPath 用 '/' 分隔，name 去扩展名）。
//   3. 按目录层级建页：每个子目录 → 一个父页（document 布局，空内容）；
//      每个 .md → 子页，content = markdownToJson(text)。
//   4. 页名优先取 .md 首个 H1，无则用文件名（去 .md）。
//   5. 全部建完后 store.reload() 一次刷树。
//
// 性能：单线程顺序建页，避免并发写 SQLite 触发 SQLITE_BUSY；
//       批量场景通常 < 200 文档，毫秒级可接受。

interface MdFile {
  absPath: string;
  /** 相对根目录的目录部分，如 "" / "foo" / "foo/bar"；文件名不在此 */
  dirRel: string;
  /** 文件名（不含 .md） */
  baseName: string;
}

/** 递归收集目录下所有 .md 文件（小写扩展名匹配，兼容 .MD 不常见场景） */
async function walkMd(rootAbs: string, relDir: string, out: MdFile[]): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await readDir(rootAbs);
  } catch (e) {
    logger.warn("import-folder.walkMd", "readDir failed", rootAbs, e);
    return;
  }
  for (const e of entries) {
    const name = e.name;
    if (!name) continue;
    if (e.isDirectory) {
      await walkMd(`${rootAbs}/${name}`, relDir ? `${relDir}/${name}` : name, out);
    } else if (e.isFile && name.toLowerCase().endsWith(".md")) {
      const baseName = name.slice(0, -3); // 去 .md（保留大小写）
      out.push({ absPath: `${rootAbs}/${name}`, dirRel: relDir, baseName });
    }
  }
}

/** 从 markdown 文本提取首个 H1 标题作为页名；无则返回 fallback */
function extractTitle(md: string, fallback: string): string {
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^#{1}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
}

export interface ImportResult {
  total: number;
  created: number;
  failed: number;
}

/**
 * 导入 Markdown 文件夹到当前 workspace。
 * @param workspaceId 当前工作区 id
 * @returns { total, created, failed }
 */
export async function importMarkdownFolder(workspaceId: string): Promise<ImportResult> {
  // 1. 选目录
  const root = await open({ directory: true, multiple: false });
  if (typeof root !== "string" || !root) return { total: 0, created: 0, failed: 0 };

  // 2. 遍历 .md
  const files: MdFile[] = [];
  await walkMd(root, "", files);
  if (files.length === 0) return { total: 0, created: 0, failed: 0 };

  // 3. 按目录层级建页：dirRel → viewId 缓存
  //    "" (根) → null（顶层页面 parent_id = null）
  const dirViewMap = new Map<string, string | null>();
  dirViewMap.set("", null);

  /** 确保目录 relDir 对应的父页存在，返回其 viewId（根返回 null） */
  async function ensureDirView(relDir: string): Promise<string | null> {
    if (!relDir) return null;
    const cached = dirViewMap.get(relDir);
    if (cached !== undefined) return cached;
    // 递归先建父目录
    const lastSlash = relDir.lastIndexOf("/");
    const parentRel = lastSlash >= 0 ? relDir.slice(0, lastSlash) : "";
    const dirName = lastSlash >= 0 ? relDir.slice(lastSlash + 1) : relDir;
    const parentId = await ensureDirView(parentRel);
    const view = await viewApi.create({
      workspace_id: workspaceId,
      parent_id: parentId,
      name: dirName,
      layout: "document",
    });
    dirViewMap.set(relDir, view.id);
    return view.id;
  }

  // 4. 顺序建页 + 写内容（顺序执行避免 SQLite 写锁竞争）
  let created = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const text = await readTextFile(f.absPath);
      const name = extractTitle(text, f.baseName);
      const parentId = await ensureDirView(f.dirRel);
      const view = await viewApi.create({
        workspace_id: workspaceId,
        parent_id: parentId,
        name,
        layout: "document",
      });
      const json = markdownToJson(text);
      await documentApi.save(view.id, JSON.stringify(json));
      created++;
    } catch (e) {
      failed++;
      logger.warn("import-folder", "import one md failed", f.absPath, e);
    }
  }

  return { total: files.length, created, failed };
}
