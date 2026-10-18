// 生成 Tauri 自动更新的清单文件 latest.json。
// Tauri 打包只产出安装包与其 .sig 签名，不会生成 latest.json，需要随 Release 一并上传，
// 应用内「设置 → 软件更新」才能读到新版本信息。
//
// 用法（默认读取 D:/Code/rust-target/release/bundle/nsis）：
//   node scripts/gen-latest-json.mjs --version 0.8.8 --repo rayfengleixing/tsflowy
// 可选：--dir <bundle 目录>、--notes <更新说明>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const REPO = "rayfengleixing/tsflowy";
/** 只发 Windows：平台键写死，避免出现 mac/linux 的空条目 */
export const PLATFORM_KEY = "windows-x86_64";

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
  const notes = arg("notes", `TsFlowy v${version}`);

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
