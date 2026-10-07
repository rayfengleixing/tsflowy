import { describe, expect, it } from "vitest";
import { detectDataDirRisk } from "./data-dir-risk";

describe("detectDataDirRisk", () => {
  it("flags data dirs inside a cloud-sync folder", () => {
    expect(detectDataDirRisk("C:\\Users\\a\\OneDrive\\TsFlowy")).toBe("cloud");
    expect(detectDataDirRisk("C:\\Users\\a\\OneDrive - 个人\\文档\\TsFlowy")).toBe("cloud");
    expect(detectDataDirRisk("/home/a/坚果云/TsFlowy")).toBe("cloud");
    expect(detectDataDirRisk("D:\\Dropbox\\Apps\\TsFlowy")).toBe("cloud");
  });

  it("does not misfire on names merely containing a marker", () => {
    expect(detectDataDirRisk("D:\\megaphone\\TsFlowy")).toBeNull();
    expect(detectDataDirRisk("C:\\Users\\a\\Documents\\TsFlowy")).toBeNull();
  });

  it("flags overlapping data dir and sync folder", () => {
    expect(detectDataDirRisk("D:\\Sync\\TsFlowy", "D:\\Sync")).toBe("sync-overlap");
    expect(detectDataDirRisk("D:\\Sync", "D:\\Sync\\sub")).toBe("sync-overlap");
    expect(detectDataDirRisk("D:\\Sync", null)).toBeNull();
    // 路径大小写与尾斜杠不影响判定
    expect(detectDataDirRisk("D:\\Data\\", "d:\\data\\tsflowy\\")).toBe("sync-overlap");
  });

  it("prefers the overlap warning and ignores empty input", () => {
    expect(detectDataDirRisk("C:\\OneDrive", "C:\\OneDrive")).toBe("sync-overlap");
    expect(detectDataDirRisk("   ")).toBeNull();
  });
});
