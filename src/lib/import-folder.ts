import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, type DirEntry } from "@tauri-apps/plugin-fs";
import { invoke } from "@/lib/invoke";
import { createDatabaseViewFromTable, parseMarkdownTable } from "./db-transfer";
import { viewApi } from "./db";
import { documentApi } from "./documents";
import { splitFrontmatter, type PageMeta } from "./frontmatter";
import { markdownToJson } from "./markdown";
import { logger } from "./logger";

// 导入 Markdown 文件夹（Phase 4.1 导入体系）。
//
// 设计：
//   1. 用户选一个目录（dialog.open({ directory: true })）。
//   2. 递归遍历收集所有 .md 文件（relPath 用 '/' 分隔，name 去扩展名）。
//   3. 按目录层级建页：每个子目录 → 一个父页；每个 .md → 子页，content = markdownToJson(text)。
//      - 目录同名文件（<目录>/<同名>.md）就是该目录页自己的正文，不再另建一个重名子页；
//      - 头部有 frontmatter `layout: grid|board|calendar|timeline` 且正文含表格 → 建数据库视图并灌入行；
//      - frontmatter 的 icon/tags/favorite 建完即回填。
//   4. 页名优先取 frontmatter title，其次 .md 首个 H1，无则用文件名（去 .md）。
//   5. 文中引用源目录内本地文件的图片/附件先收进本机 assets/ 再改写引用，
//      否则导入后的文档指向源目录路径，换台机器（或源目录被删）就永远裂图。
//   6. 全部建完后 store.reload() 一次刷树。
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

/* ————— 本地图片 / 附件收编 ————— */

/** `![alt](target)`（图片）与 `[name](target)`（链接，仅 attach: 前缀的附件引用要处理） */
const REF_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
/** 导出格式给图片链接加的宽度尾缀：`![a](img.png{width=60%})` */
const WIDTH_SUFFIX_RE = /\{width=\d+%\}$/;
/** 附件引用的协议前缀（与 markdown.ts 导出格式一致） */
const ATTACH_PREFIX = "attach:";
/** `http:`/`data:`/`C:` 等：带协议或盘符的引用不属于"源目录内相对路径" */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 路径按 '/' 归一并解析 `.`/`..`；越出盘符根时返回 null */
function resolveRelative(baseDir: string, rel: string): string | null {
  const stack = baseDir.split(/[\\/]+/).filter((s) => s && s !== ".");
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length <= 1) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join("/");
}

/** 是否落在用户选定的源目录内（越出去的引用不读，也不可能被对话框授权） */
function isInsideRoot(rootAbs: string, absPath: string): boolean {
  const root = rootAbs.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const abs = absPath.replace(/\\/g, "/").toLowerCase();
  return abs === root || abs.startsWith(`${root}/`);
}

function decodeUriPath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

/**
 * 拆出链接 target 的图片/附件引用相对路径，并保留需要原样回填的尾缀
 * （`<…>` 包裹、`"title"`、`{width=N%}`）。返回 null 表示这条引用不处理。
 */
function splitLocalRef(isImage: boolean, target: string): { src: string; attach: boolean; tail: string } | null {
  let rest = target.trim();
  let tail = "";

  const width = WIDTH_SUFFIX_RE.exec(rest);
  if (width) {
    tail = rest.slice(width.index) + tail;
    rest = rest.slice(0, width.index);
  }
  const angle = /^<(.*)>$/.exec(rest);
  if (angle) rest = angle[1];
  else {
    const title = /^(.*\S)\s+(["'][^"'\n]*["'])$/.exec(rest);
    if (title) {
      rest = title[1];
      tail = `${title[2]}${tail}`;
    }
  }

  const attach = !isImage && rest.startsWith(ATTACH_PREFIX);
  if (attach) rest = rest.slice(ATTACH_PREFIX.length);
  // 非图片的普通链接只认 attach: 前缀（本库导出格式），其余一律不动
  else if (!isImage) return null;

  if (!rest || rest.startsWith("/") || rest.startsWith("\\") || rest.startsWith("#") || SCHEME_RE.test(rest)) {
    return null;
  }
  return { src: decodeUriPath(rest), attach, tail };
}

/** 源目录内的本地文件 → save_asset 复制进本机 assets/；失败（含文件不存在）返回 null */
async function copyIntoLibrary(absPath: string, cache: Map<string, string | null>): Promise<string | null> {
  const hit = cache.get(absPath);
  if (hit !== undefined) return hit;
  try {
    const relative = await invoke<string>("save_asset", { sourcePath: absPath });
    cache.set(absPath, relative);
    return relative;
  } catch (e) {
    logger.warn("import-folder", "local asset copy failed", absPath, e);
    cache.set(absPath, null);
    return null;
  }
}

/**
 * 把 markdown 里指向源目录本地的图片/附件引用换成收编后的本机 `assets/xxx` 路径。
 * 远程 URL、data URI、解析不到本机文件的引用保持原样；单条失败不影响本文导入。
 */
export async function localizeLocalRefs(
  text: string,
  mdPath: string,
  rootAbs: string,
  cache: Map<string, string | null>,
): Promise<string> {
  const baseDir = mdPath.slice(0, Math.max(mdPath.lastIndexOf("/"), mdPath.lastIndexOf("\\")));
  const out: string[] = [];
  let cursor = 0;
  const re = new RegExp(REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(cursor, m.index), m[0]);
    cursor = m.index + m[0].length;

    const ref = splitLocalRef(m[1] === "!", m[3]);
    if (!ref) continue;
    const absPath = resolveRelative(baseDir, ref.src);
    if (!absPath || !isInsideRoot(rootAbs, absPath)) continue;
    const relative = await copyIntoLibrary(absPath, cache);
    if (!relative) continue;
    // 已收编：整段引用回填为本机路径（附件保留 attach: 前缀，导入时可再次还原成附件节点）
    out[out.length - 1] = `${m[1]}[${m[2]}](${ref.attach ? ATTACH_PREFIX : ""}${relative}${ref.tail})`;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

export interface ImportResult {
  total: number;
  created: number;
  failed: number;
}

/** 回填 frontmatter 里的页面属性；单项失败只记日志（页面本身已经建出来了，不该因此整篇算失败） */
async function applyViewMeta(viewId: string, meta: PageMeta): Promise<void> {
  try {
    if (meta.icon) await viewApi.setIcon(viewId, meta.icon);
    const tags = meta.tags ?? [];
    if (tags.length > 0) await viewApi.setTags(viewId, tags);
    if (meta.favorite === true) await viewApi.setFavorite(viewId, true);
  } catch (e) {
    logger.warn("import-folder", "apply page meta failed", viewId, e);
  }
}

/**
 * 导入 Markdown 文件夹到当前 workspace。
 * @param workspaceId 当前工作区 id
 * @returns { total, created, failed }
 */
export async function importMarkdownFolder(workspaceId: string): Promise<ImportResult> {
  // 1. 选目录（recursive: true 让 dialog 把整棵子树授权给 fs scope，嵌套 .md 才能读取）
  const root = await open({ directory: true, multiple: false, recursive: true });
  if (typeof root !== "string" || !root) return { total: 0, created: 0, failed: 0 };

  // 2. 遍历 .md
  const files: MdFile[] = [];
  await walkMd(root, "", files);
  if (files.length === 0) return { total: 0, created: 0, failed: 0 };

  // 2.1 目录同名文件（<目录>/<同名>.md）是「该目录页的正文」，先建好并登记，
  //     避免它作为普通子页再建一次（导出树是 <页面>/<页面>.md + 子页.md，导入必须一一对应）
  const selfByDir = new Map<string, MdFile>();
  for (const f of files) {
    if (!f.dirRel) continue;
    const lastSlash = f.dirRel.lastIndexOf("/");
    const leaf = lastSlash >= 0 ? f.dirRel.slice(lastSlash + 1) : f.dirRel;
    if (leaf === f.baseName) selfByDir.set(f.dirRel, f);
  }

  // 3. 按目录层级建页：dirRel → viewId 缓存
  //    "" (根) → null（顶层页面 parent_id = null）
  const dirViewMap = new Map<string, string | null>();
  dirViewMap.set("", null);
  // 已作为目录页正文消费掉的文件，主循环不再重复建页
  const consumed = new Set<string>();
  let created = 0;
  let failed = 0;
  // 同一源文件被多篇文档引用时只复制一次（值为本机相对路径，null = 已试过且失败）
  const assetCache = new Map<string, string | null>();
  // 「目录同名文件」会先在建目录页时读一遍，主循环再遇到同一文件不重复读盘
  const bodyCache = new Map<string, { meta: PageMeta; localized: string }>();

  /** 从源文件读出正文（拆 frontmatter + 收编本地引用）；同一文件只读一次 */
  const readBody = async (f: MdFile): Promise<{ meta: PageMeta; localized: string }> => {
    const hit = bodyCache.get(f.absPath);
    if (hit) return hit;
    const text = await readTextFile(f.absPath);
    const { meta, body } = splitFrontmatter(text);
    const parsed = { meta, localized: await localizeLocalRefs(body, f.absPath, root, assetCache) };
    bodyCache.set(f.absPath, parsed);
    return parsed;
  };

  /** 用「目录同名文件」建目录页：数据库表格 → grid 视图；否则文档页 */
  async function createDirPage(relDir: string, self: MdFile, parentId: string | null): Promise<string> {
    const dirName = relDir.slice(relDir.lastIndexOf("/") + 1);
    const { meta, localized } = await readBody(self);
    consumed.add(self.absPath);
    const table = meta.layout && meta.layout !== "document" ? parseMarkdownTable(localized) : null;
    if (table) {
      const { viewId } = await createDatabaseViewFromTable(workspaceId, parentId, meta.title ?? dirName, table);
      await applyViewMeta(viewId, meta);
      return viewId;
    }
    const view = await viewApi.create({
      workspace_id: workspaceId,
      parent_id: parentId,
      name: meta.title ?? extractTitle(localized, dirName),
      layout: "document",
    });
    const json = markdownToJson(localized);
    await documentApi.save(view.id, JSON.stringify(json));
    await applyViewMeta(view.id, meta);
    return view.id;
  }

  /** 确保目录 relDir 对应的父页存在，返回其 viewId（根返回 null） */
  async function ensureDirView(relDir: string): Promise<string | null> {
    if (!relDir) return null;
    const cached = dirViewMap.get(relDir);
    if (cached !== undefined) return cached;
    // 递归先建父目录
    const lastSlash = relDir.lastIndexOf("/");
    const parentRel = lastSlash >= 0 ? relDir.slice(0, lastSlash) : "";
    const self = selfByDir.get(relDir);
    const parentId = await ensureDirView(parentRel);
    let viewId: string | null = null;
    if (self) {
      try {
        viewId = await createDirPage(relDir, self, parentId);
        created++;
      } catch (e) {
        failed++;
        logger.warn("import-folder", "directory page import failed", self.absPath, e);
        // 目录页建失败也不能让整棵子树无父：退化成空文档页继续
        const fallback = await viewApi.create({
          workspace_id: workspaceId,
          parent_id: parentId,
          name: relDir.slice(lastSlash + 1),
          layout: "document",
        });
        viewId = fallback.id;
      }
    } else {
      const view = await viewApi.create({
        workspace_id: workspaceId,
        parent_id: parentId,
        name: relDir.slice(lastSlash + 1),
        layout: "document",
      });
      viewId = view.id;
    }
    dirViewMap.set(relDir, viewId);
    return viewId;
  }

  // 4. 顺序建页 + 写内容（顺序执行避免 SQLite 写锁竞争）
  for (const f of files) {
    try {
      // 先建父页：父页可能就是本文件（目录同名文件），此时本页已在此处建好并登记消费
      const parentId = await ensureDirView(f.dirRel);
      if (consumed.has(f.absPath)) continue;
      const { meta, localized } = await readBody(f);
      const name = meta.title ?? extractTitle(localized, f.baseName);
      const table = meta.layout && meta.layout !== "document" ? parseMarkdownTable(localized) : null;
      if (table) {
        const { viewId } = await createDatabaseViewFromTable(workspaceId, parentId, name, table);
        await applyViewMeta(viewId, meta);
        created++;
        continue;
      }
      const view = await viewApi.create({
        workspace_id: workspaceId,
        parent_id: parentId,
        name,
        layout: "document",
      });
      const json = markdownToJson(localized);
      await documentApi.save(view.id, JSON.stringify(json));
      await applyViewMeta(view.id, meta);
      created++;
    } catch (e) {
      failed++;
      logger.warn("import-folder", "import one md failed", f.absPath, e);
    }
  }

  return { total: files.length, created, failed };
}
