import { describe, expect, it } from "vitest";

import pkg from "../../package.json";
import tauriConf from "../../src-tauri/tauri.conf.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import releaseNotes from "../../更新说明.md?raw";
import { PLATFORM_KEY, REPO, buildManifest, exeNameFor, extractSection } from "../../scripts/gen-latest-json.mjs";

// 发布链路上最容易出错的两处，都在这里钉住：
// 1）latest.json 的 url 必须由 tag + 安装包文件名拼出来 —— 与 gh release 实际上传的名字对不上，
//    应用内「检查更新」就是 404，签名再对也装不上；
// 2）三处版本号（package.json / tauri.conf.json / Cargo.toml）必须一致，且更新说明里要有对应章节，
//    漏升一处会打出旧版本号的安装包，而更新清单已经指向新版本。
// 这个测试跑在 npm test（CI 的 vitest 步骤）里，所以不必动 .github/workflows 就有护栏。
// latest.json 的 notes 默认就是从 更新说明.md 抽本版章节，抽取口径（到下一个 `## ` 为止、
// 去掉结尾 `---`）在下面单独钉住，免得口径漂了却没人发现。

/** Cargo.toml 不能像 JSON 那样直接解析，只取 [package] 段里的第一行 version */
function cargoVersion(source: string): string {
  const pkg = source.slice(source.indexOf("[package]"));
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(pkg);
  if (!m) throw new Error("Cargo.toml 的 [package] 段里找不到 version");
  return m[1];
}

const sample = {
  version: "0.8.30",
  notes: "TsFlowy v0.8.30",
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6",
  pubDate: "2026-10-18T08:00:00.000Z",
};

describe("latest.json 清单形状", () => {
  it("只有 Windows 一个平台键", () => {
    const manifest = buildManifest(sample);
    expect(Object.keys(manifest.platforms)).toEqual([PLATFORM_KEY]);
    expect(PLATFORM_KEY).toBe("windows-x86_64");
  });

  it("下载地址由 tag 与安装包文件名拼成，与 gh release 的产物名一致", () => {
    const manifest = buildManifest(sample);
    expect(exeNameFor("0.8.30")).toBe("TsFlowy_0.8.30_x64-setup.exe");
    expect(manifest.platforms[PLATFORM_KEY].url).toBe(
      `https://github.com/${REPO}/releases/download/v0.8.30/TsFlowy_0.8.30_x64-setup.exe`,
    );
  });

  it("version / notes / pub_date / signature 原样透传，不掺默认值", () => {
    const manifest = buildManifest(sample);
    expect(manifest.version).toBe("0.8.30");
    expect(manifest.notes).toBe("TsFlowy v0.8.30");
    expect(manifest.pub_date).toBe("2026-10-18T08:00:00.000Z");
    expect(manifest.platforms[PLATFORM_KEY].signature).toBe(sample.signature);
  });
});

describe("发布前的版本一致性", () => {
  it("package.json / tauri.conf.json / Cargo.toml 三处版本号相同", () => {
    expect(pkg.version).toBeTruthy();
    expect(tauriConf.version).toBe(pkg.version);
    expect(cargoVersion(cargoToml)).toBe(pkg.version);
  });

  it("更新说明里有当前版本的章节（发布 notes 从这里抽取）", () => {
    expect(releaseNotes).toContain(`## v${pkg.version}`);
  });

  it("仓库命名空间没写错（下载地址用的就是它）", () => {
    expect(REPO).toBe("rayfengleixing/tsflowy");
  });
});

describe("发布说明章节抽取（latest.json 的 notes 取自这里）", () => {
  const sampleNotes = [
    "# TsFlowy 更新说明",
    "",
    "---",
    "",
    "## v0.8.31 — 2026-10-19",
    "",
    "后一版的内容。",
    "",
    "---",
    "",
    "## v0.8.30 — 2026-10-18",
    "",
    "本版的第一条。",
    "",
    "### 安装包",
    "",
    "Windows x64 NSIS 安装包：`TsFlowy_0.8.30_x64-setup.exe`",
    "",
    "---",
    "",
    "## v0.8.29 — 2026-10-16",
    "",
    "前一版的内容。",
    "",
    "---",
  ].join("\n");

  it("从本版标题起、到下一个 `## ` 之前，去掉结尾的分隔线", () => {
    const section = extractSection(sampleNotes, "0.8.30");
    expect(section?.startsWith("## v0.8.30 —")).toBe(true);
    expect(section).toContain("本版的第一条。");
    expect(section).toContain("### 安装包");
    expect(section?.endsWith("`TsFlowy_0.8.30_x64-setup.exe`")).toBe(true);
    expect(section).not.toContain("前一版的内容");
    expect(section).not.toContain("后一版的内容");
    expect(section).not.toContain("---");
  });

  it("版本号按整段匹配：v0.8.3 不会命中 v0.8.30，也没有对应章节", () => {
    expect(extractSection(sampleNotes, "0.8.3")).toBeNull();
  });

  it("章节里只剩标题时也返回标题本身，空串不算命中", () => {
    expect(extractSection("## v1.0.0 — 2026-01-01\n\n---\n\n## v0.9.9\n", "1.0.0")).toBe("## v1.0.0 — 2026-01-01");
    expect(extractSection("# 只有文件标题\n", "1.0.0")).toBeNull();
  });

  it("真实 更新说明.md 里当前版本只有一节，且带着本版内容", () => {
    const section = extractSection(releaseNotes, pkg.version);
    expect(section).not.toBeNull();
    expect(section?.split("\n").filter((line) => line.startsWith("## v"))).toEqual([
      expect.stringMatching(`^## v${pkg.version.replace(/\./g, "\\.")} — \\d{4}-\\d{2}-\\d{2}$`),
    ]);
    expect(section).toContain(`TsFlowy_${pkg.version}_x64-setup.exe`);
    // 上一版的章节不能混进来：Release 说明只取本节
    expect(section).not.toContain(`TsFlowy_0.8.32_x64-setup.exe`);
  });

  it("notes 原样进清单，不再是 TsFlowy v{version} 占位串", () => {
    const section = extractSection(releaseNotes, pkg.version) ?? "";
    const manifest = buildManifest({ version: pkg.version, notes: section, signature: "sig", pubDate: "now" });
    expect(manifest.notes).toBe(section);
    expect(manifest.notes).not.toBe(`TsFlowy v${pkg.version}`);
  });
});
