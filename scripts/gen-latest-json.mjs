// 生成 Tauri 自动更新的清单文件 latest.json。
// Tauri 打包只产出安装包与其 .sig 签名，不会生成 latest.json，需要随 Release 一并上传，
// 应用内「设置 → 软件更新」才能读到新版本信息。
//
// 用法（默认读取 D:/Code/rust-target/release/bundle/nsis）：
//   node scripts/gen-latest-json.mjs --version 0.8.8 --repo rayfengleixing/tsflowy
// 可选：--dir <bundle 目录>、--notes <更新说明>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const version = arg("version");
if (!version) {
  console.error("缺少 --version，例如：--version 0.8.8");
  process.exit(1);
}
const repo = arg("repo", "rayfengleixing/tsflowy");
const dir = arg("dir", "D:/Code/rust-target/release/bundle/nsis");
const notes = arg("notes", `TsFlowy v${version}`);

const exeName = `TsFlowy_${version}_x64-setup.exe`;
const exePath = join(dir, exeName);
const sigPath = `${exePath}.sig`;
for (const p of [exePath, sigPath]) {
  if (!existsSync(p)) {
    console.error(`找不到文件：${p}`);
    process.exit(1);
  }
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${exeName}`,
    },
  },
};

const out = join(dir, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`已生成 ${out}`);
