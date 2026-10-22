import { open } from "@/lib/ipc-dialog";
import { readDir, readTextFile, type DirEntry } from "@/lib/ipc-fs";
import { invoke } from "@/lib/invoke";
import { createDatabaseViewFromTable, parseMarkdownTable } from "./db-transfer";
import { viewApi } from "./db";
import { documentApi } from "./documents";
import { EXPORT_MANIFEST_FILE, parseExportManifest } from "./export-manifest";
import { splitFrontmatter, type PageMeta } from "./frontmatter";
import { markdownToJson } from "./markdown";
import { logger } from "./logger";
import { isDbLayout, type DbLayout, type LayoutType } from "@/types/models";

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
//      http(s) 图片同样下载到本机（默认开，设置页可关）：源目录能跟着拷，远程链接不会。
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
/** 只有 http(s) 图片值得联网收编；data: 已自带内容，其它协议一律不碰 */
const REMOTE_IMAGE_RE = /^https?:\/\//i;

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
 * 拆出链接 target 的图片/附件引用，并保留需要原样回填的尾缀
 * （`<…>` 包裹、`"title"`、`{width=N%}`）。返回 null 表示这条引用不处理。
 * `remote: true` 时 src 是 http(s) 图片地址，需要联网下载而不是从源目录读文件。
 */
function splitLocalRef(
  isImage: boolean,
  target: string,
): { src: string; attach: boolean; tail: string; remote: boolean } | null {
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

  // 远程图片原样交给 fetch 命令：这里不能再 decode，否则签名 URL 里的 %2B 会变成 +
  // 远程附件（attach:http…）不收：下载来的文件没有本地语义，保持原链接即可
  if (isImage && REMOTE_IMAGE_RE.test(rest)) return { src: rest, attach: false, tail, remote: true };

  if (!rest || rest.startsWith("/") || rest.startsWith("\\") || rest.startsWith("#") || SCHEME_RE.test(rest)) {
    return null;
  }
  return { src: decodeUriPath(rest), attach, tail, remote: false };
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

/** 远程 http(s) 图片 → Rust 侧下载进本机 assets/；失败返回 null（保留原链接） */
async function fetchIntoLibrary(url: string, cache: Map<string, string | null>): Promise<string | null> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  try {
    const relative = await invoke<string>("fetch_remote_asset", { url });
    cache.set(url, relative);
    return relative;
  } catch (e) {
    logger.warn("import-folder", "remote image fetch failed", url, e);
    cache.set(url, null);
    return null;
  }
}

/** 远程图片本地化开关的存储键；值 "0" 表示用户关掉了下载 */
const FETCH_REMOTE_KEY = "tsflowy:import-fetch-remote";

/** 默认开启：导入到另一台机器或断网后才发现远程图裂了，是最常见的后悔点 */
export function isRemoteFetchEnabled(): boolean {
  try {
    return localStorage.getItem(FETCH_REMOTE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setRemoteFetchEnabled(on: boolean): void {
  try {
    localStorage.setItem(FETCH_REMOTE_KEY, on ? "1" : "0");
  } catch {
    /* localStorage 被禁用：这台机器沿用默认的「开」 */
  }
}

/**
 * 把 markdown 里的图片/附件引用换成本机 `assets/xxx` 路径：
 * 源目录内的本地文件复制收编，http(s) 图片按需下载（`fetchRemote` 关时保持原样）。
 * data URI、解析不到的本地文件、下载失败的远程图一律保留原引用，单条失败不影响本文导入。
 */
export async function localizeRefs(
  text: string,
  mdPath: string,
  rootAbs: string,
  opts: { cache: Map<string, string | null>; fetchRemote: boolean },
): Promise<{ text: string; remoteFailed: number }> {
  const baseDir = mdPath.slice(0, Math.max(mdPath.lastIndexOf("/"), mdPath.lastIndexOf("\\")));
  const out: string[] = [];
  let cursor = 0;
  let remoteFailed = 0;
  const re = new RegExp(REF_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(cursor, m.index), m[0]);
    cursor = m.index + m[0].length;

    const ref = splitLocalRef(m[1] === "!", m[3]);
    if (!ref) continue;

    let relative: string | null;
    if (ref.remote) {
      if (!opts.fetchRemote) continue;
      relative = await fetchIntoLibrary(ref.src, opts.cache);
      if (!relative) remoteFailed++;
    } else {
      const absPath = resolveRelative(baseDir, ref.src);
      if (!absPath || !isInsideRoot(rootAbs, absPath)) continue;
      relative = await copyIntoLibrary(absPath, opts.cache);
    }
    if (!relative) continue;
    // 已收编：整段引用回填为本机路径（附件保留 attach: 前缀，导入时可再次还原成附件节点）
    out[out.length - 1] = `${m[1]}[${m[2]}](${ref.attach ? ATTACH_PREFIX : ""}${relative}${ref.tail})`;
  }
  out.push(text.slice(cursor));
  return { text: out.join(""), remoteFailed };
}

const EMPTY_IMPORT: ImportResult = {
  total: 0,
  created: 0,
  failed: 0,
  dangling_refs: 0,
  relinked_refs: 0,
  remote_failed: 0,
};

export interface ImportResult {
  total: number;
  created: number;
  failed: number;
  /** 接不回原目标的跨页引用数（旧库 id 在清单和同名匹配里都找不到） */
  dangling_refs: number;
  /** 成功换成本次新建 id 的跨页引用数 */
  relinked_refs: number;
  /** 下载失败、只能保留远程链接的图片引用数（关掉下载时恒为 0） */
  remote_failed: number;
}

/** 递归重写跨页引用：mention 的 id 与 databaseView 的 viewId 从旧库 id 换成本次新建的 id */
function remapRefs(
  node: unknown,
  resolve: (oldId: string, label: string) => string | null,
  counters: { relinked: number; dangling: number },
): void {
  if (Array.isArray(node)) {
    for (const child of node) remapRefs(child, resolve, counters);
    return;
  }
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  const attrs = rec.attrs as Record<string, unknown> | undefined;
  const key = rec.type === "databaseView" ? "viewId" : rec.type === "mention" ? "id" : null;
  if (attrs && key) {
    const oldId = attrs[key];
    if (typeof oldId === "string" && oldId) {
      const label = typeof attrs.label === "string" ? attrs.label : "";
      const name = typeof attrs.name === "string" ? attrs.name : "";
      const newId = resolve(oldId, label || name);
      if (newId) {
        attrs[key] = newId;
        counters.relinked++;
      } else {
        // 目标页没跟着一起导入：留着旧 id 只剩一个点了没反应的链接，
        // 清空后前端按纯文本标签降级显示（mention 的 label 兜底）
        attrs[key] = "";
        counters.dangling++;
      }
    }
  }
  remapRefs(rec.content, resolve, counters);
}

/** frontmatter 的 layout 决定建出的数据库视图用哪个布局；缺省或 document 落回表格 */
function dbLayoutOf(layout: LayoutType | undefined): DbLayout {
  return layout && isDbLayout(layout) ? layout : "grid";
}

/** 回填 frontmatter 里的页面属性；单项失败只记日志（页面本身已经建出来了，不该因此整篇算失败） */
async function applyViewMeta(viewId: string, meta: PageMeta): Promise<void> {
  try {
    if (meta.icon) await viewApi.setIcon(viewId, meta.icon);
    const tags = meta.tags ?? [];
    if (tags.length > 0) await viewApi.setTags(viewId, tags);
    const aliases = meta.aliases ?? [];
    if (aliases.length > 0) await viewApi.setAliases(viewId, aliases);
    if (meta.favorite === true) await viewApi.setFavorite(viewId, true);
  } catch (e) {
    logger.warn("import-folder", "apply page meta failed", viewId, e);
  }
}

/**
 * 导入 Markdown 文件夹到当前 workspace。
 * @param workspaceId 当前工作区 id
 * @returns 建页数与各类引用收编/接回/失败计数（见 ImportResult）
 */
export async function importMarkdownFolder(workspaceId: string): Promise<ImportResult> {
  // 1. 选目录（recursive: true 让 dialog 把整棵子树授权给 fs scope，嵌套 .md 才能读取）
  const root = await open({ directory: true, multiple: false, recursive: true });
  if (typeof root !== "string" || !root) return { ...EMPTY_IMPORT };

  // 1.1 引用清单：导出端留下的 viewId → 相对路径。老导出目录没有这个文件，
  //     届时退化成「按页面标题匹配」，能接多少接多少
  let manifestViews: Record<string, string> = {};
  try {
    const raw = await readTextFile(`${root}/${EXPORT_MANIFEST_FILE}`);
    manifestViews = parseExportManifest(raw)?.views ?? {};
  } catch {
    /* 没有清单 */
  }

  // 2. 遍历 .md
  const files: MdFile[] = [];
  await walkMd(root, "", files);
  if (files.length === 0) return { ...EMPTY_IMPORT };

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
  // 远程图片是否联网收编（默认开，可在设置页关掉）
  const fetchRemote = isRemoteFetchEnabled();
  let remoteFailed = 0;
  // 「目录同名文件」会先在建目录页时读一遍，主循环再遇到同一文件不重复读盘
  const bodyCache = new Map<string, { meta: PageMeta; localized: string }>();
  /** 相对路径（含 .md）→ 本次新建的 viewId：导出清单里的旧 id 靠它对回新页 */
  const newByRelPath = new Map<string, string>();
  /** 页面标题 → viewId；同名出现过两次就置 null，标题兜底只在唯一命中时生效 */
  const newByTitle = new Map<string, string | null>();
  /** 正文攒到所有页面建完再写：跨页引用可能指向后面才建的页，提前写就没机会换 id 了 */
  const docWrites: { viewId: string; json: unknown }[] = [];

  const relPathOf = (f: MdFile): string => `${f.dirRel ? `${f.dirRel}/` : ""}${f.baseName}.md`;
  const registerView = (viewId: string, relPath: string, title: string): void => {
    newByRelPath.set(relPath, viewId);
    newByTitle.set(title, newByTitle.has(title) ? null : viewId);
  };

  /** 从源文件读出正文（拆 frontmatter + 收编图片/附件引用）；同一文件只读一次，失败数也只计一次 */
  const readBody = async (f: MdFile): Promise<{ meta: PageMeta; localized: string }> => {
    const hit = bodyCache.get(f.absPath);
    if (hit) return hit;
    const text = await readTextFile(f.absPath);
    const { meta, body } = splitFrontmatter(text);
    const refs = await localizeRefs(body, f.absPath, root, { cache: assetCache, fetchRemote });
    remoteFailed += refs.remoteFailed;
    const parsed = { meta, localized: refs.text };
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
      const title = meta.title ?? dirName;
      const { viewId } = await createDatabaseViewFromTable(
        workspaceId,
        parentId,
        title,
        table,
        dbLayoutOf(meta.layout),
      );
      await applyViewMeta(viewId, meta);
      registerView(viewId, relPathOf(self), title);
      return viewId;
    }
    const name = meta.title ?? extractTitle(localized, dirName);
    const view = await viewApi.create({
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      layout: "document",
    });
    docWrites.push({ viewId: view.id, json: markdownToJson(localized) });
    registerView(view.id, relPathOf(self), name);
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
        const { viewId } = await createDatabaseViewFromTable(
          workspaceId,
          parentId,
          name,
          table,
          dbLayoutOf(meta.layout),
        );
        await applyViewMeta(viewId, meta);
        registerView(viewId, relPathOf(f), name);
        created++;
        continue;
      }
      const view = await viewApi.create({
        workspace_id: workspaceId,
        parent_id: parentId,
        name,
        layout: "document",
      });
      docWrites.push({ viewId: view.id, json: markdownToJson(localized) });
      registerView(view.id, relPathOf(f), name);
      await applyViewMeta(view.id, meta);
      created++;
    } catch (e) {
      failed++;
      logger.warn("import-folder", "import one md failed", f.absPath, e);
    }
  }

  // 5. 页面全建完了，才把正文里的旧库 id 换成本次新建的 id，再统一落库。
  //    优先按导出清单的 viewId→路径 对回；没有清单（老版本导出目录）时按页面标题兜底。
  const oldToNew = new Map<string, string>();
  for (const [oldId, relPath] of Object.entries(manifestViews)) {
    const newId = newByRelPath.get(relPath.replace(/\\/g, "/"));
    if (newId) oldToNew.set(oldId, newId);
  }
  const resolve = (oldId: string, label: string): string | null =>
    oldToNew.get(oldId) ?? (label ? (newByTitle.get(label) ?? null) : null);

  const counters = { relinked: 0, dangling: 0 };
  for (const { viewId, json } of docWrites) {
    remapRefs(json, resolve, counters);
    try {
      await documentApi.save(viewId, JSON.stringify(json));
    } catch (e) {
      logger.warn("import-folder", "document write failed after import", viewId, e);
    }
  }

  return {
    total: files.length,
    created,
    failed,
    relinked_refs: counters.relinked,
    dangling_refs: counters.dangling,
    remote_failed: remoteFailed,
  };
}
