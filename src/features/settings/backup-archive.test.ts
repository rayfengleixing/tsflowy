import { describe, expect, it } from "vitest";

import { sortBackupArchives, type BackupArchive } from "./backup-archive";

const item = (name: string, mtime_ms: number): BackupArchive => ({
  name,
  size: 1024,
  modified: "2026-10-02 12:00:00",
  mtime_ms,
});

describe("sortBackupArchives", () => {
  it("按修改时间新→旧，不受混合命名模式的字典序影响", () => {
    const input = [
      item("auto-20260103-000000.zip", 100),
      item("tsflowy-backup-20260101-0000.zip", 300),
      item("auto-20260102-000001.zip", 200),
    ];
    expect(sortBackupArchives(input).map((f) => f.name)).toEqual([
      "tsflowy-backup-20260101-0000.zip",
      "auto-20260102-000001.zip",
      "auto-20260103-000000.zip",
    ]);
  });

  it("不改动传入数组（渲染列表依赖的引用保持稳定）", () => {
    const input = [item("auto-a.zip", 1), item("auto-b.zip", 2)];
    const snapshot = [...input];
    sortBackupArchives(input);
    expect(input).toEqual(snapshot);
  });

  it("空列表原样返回", () => {
    expect(sortBackupArchives([])).toEqual([]);
  });
});
