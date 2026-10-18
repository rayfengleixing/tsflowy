import { describe, expect, it } from "vitest";

import pkg from "../../package.json";
import tauriConf from "../../src-tauri/tauri.conf.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import releaseNotes from "../../更新说明.md?raw";
import { PLATFORM_KEY, REPO, buildManifest, exeNameFor } from "../../scripts/gen-latest-json.mjs";

// 发布链路上最容易出错的两处，都在这里钉住：
// 1）latest.json 的 url 必须由 tag + 安装包文件名拼出来 —— 与 gh release 实际上传的名字对不上，
//    应用内「检查更新」就是 404，签名再对也装不上；
// 2）三处版本号（package.json / tauri.conf.json / Cargo.toml）必须一致，且更新说明里要有对应章节，
//    漏升一处会打出旧版本号的安装包，而更新清单已经指向新版本。
// 这个测试跑在 npm test（CI 的 vitest 步骤）里，所以不必动 .github/workflows 就有护栏。

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
