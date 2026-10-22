// 生成 Tauri 自动更新的清单文件 latest.json。
// Tauri 打包只产出安装包与其 .sig 签名，不会生成 latest.json，需要随 Release 一并上传，
// 应用内「设置 → 软件更新」才能读到新版本信息。
//
// 用法（默认读取 D:/Code/rust-target/release/bundle/nsis）：
//   node scripts/gen-latest-json.mjs --version 0.8.8 --repo rayfengleixing/tsflowy
// 可选：--dir <bundle 目录>、--notes <更新说明>
//
// notes 的默认来源是仓库根目录的 更新说明.md，取当前版本那一节（口径见文件头部约定：
// `## v{version}` 起、到下一个 `## ` 之前、去掉结尾的 `---`）。章节缺失时直接失败而不是
// 退回占位串，免得发布出去的安装包说明和 latest.json 里的说法不一致；
// 确实要手写成一条，用 --notes 显式传入。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REPO = "rayfengleixing/tsflowy";
/** 只发 Windows：平台键写死，避免出现 mac/linux 的空条目 */
export const PLATFORM_KEY = "windows-x86_64";

/** 发布说明的权威文件，与 gh release 的 --notes-file 用的是同一份 */
export const RELEASE_NOTES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "更新说明.md");

/** 安装包文件名必须与 NSIS 产物、gh release 上传的文件名三处一致，故集中在这里 */
export function exeNameFor(version) {
  return `TsFlowy_${version}_x64-setup.exe`;
}

/**
 * 清单本体（纯函数，供 src/lib/release-manifest.test.ts 校验形状）：
 * url 是由 tag 拼出来的，tag 与文件名任何一处写错，应用内检查更新就会 404。
 */
export function buildManifest({ version, repo = REPO, notes, signature, pubDate, exeName = exeNameFor(version) }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [PLATFORM_KEY]: {
        signature,
        url: `https://github.com/${repo}/releases/download/v${version}/${exeName}`,
      },
    },
  };
}

/**
 * 从 更新说明.md 里取出某版本的发布说明章节（含 `## v{version} — 日期` 那一行标题）。
 * 纯字符串处理，不碰文件系统，便于测试直接喂样本。找不到章节返回 null。
 *
 * @param {string} markdown
 * @param {string} version
 * @returns {string | null}
 */
export function extractSection(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?![\d.]) 防止 v0.8.3 命中 v0.8.30 或 v0.8.3-rc 这样的相邻版本
  const heading = new RegExp(`^## v${escaped}(?![\\d.])`);
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start, end);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (body.length && /^---\s*$/.test(body[body.length - 1])) body.pop();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join("\n").trim();
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const version = arg("version");
  if (!version) {
    console.error("缺少 --version，例如：--version 0.8.8");
    process.exit(1);
  }
  const repo = arg("repo", REPO);
  const dir = arg("dir", "D:/Code/rust-target/release/bundle/nsis");

  let notes = arg("notes");
  if (notes) {
    console.log(`notes 用命令行传入的文本（${notes.length} 字）`);
  } else {
    if (!existsSync(RELEASE_NOTES_PATH)) {
      console.error(`找不到更新说明文件：${RELEASE_NOTES_PATH}；确需手写时用 --notes`);
      process.exit(1);
    }
    const section = extractSection(readFileSync(RELEASE_NOTES_PATH, "utf8"), version);
    if (section === null) {
      console.error(
        `${RELEASE_NOTES_PATH} 里没有 ## v${version} 章节：先把本版发布说明补进去（版本号权威源是 package.json），或用 --notes 显式传入`,
      );
      process.exit(1);
    }
    notes = section;
    console.log(`notes 取自 更新说明.md 的 ## v${version} 章节（${notes.length} 字）`);
  }

  const exePath = join(dir, exeNameFor(version));
  const sigPath = `${exePath}.sig`;
  for (const p of [exePath, sigPath]) {
    if (!existsSync(p)) {
      console.error(`找不到文件：${p}`);
      process.exit(1);
    }
  }

  const manifest = buildManifest({
    version,
    repo,
    notes,
    signature: readFileSync(sigPath, "utf8").trim(),
    pubDate: new Date().toISOString(),
  });

  const out = join(dir, "latest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`已生成 ${out}`);
}

// 只在 `node scripts/gen-latest-json.mjs` 直接执行时跑 CLI：
// vitest 会 import 本模块取 buildManifest，此时不能让顶层代码读 argv、exit 进程。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
