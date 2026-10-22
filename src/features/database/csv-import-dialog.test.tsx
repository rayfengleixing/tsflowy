// @vitest-environment jsdom
// 附件列的「选文件夹 → 递归扫描 → 按名匹配」是导入链路上最容易悄悄失效的一段：
// 它同时吃对话框、目录列举和路径拼接三条 IPC 边界。这里三条都用替身，
// 组件与真实的 scanFilesRecursive / resolveAttachmentNames 一行不改地跑完。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CsvImportDialog } from "./CsvImportDialog";
import { dialogCalls, queueOpenDialog, readDir, resetIpcMock, setFsDir } from "@/test/tauri-mock";
import type { FieldType } from "@/types/database";

// vi.mock 会被提到文件最前，工厂里用动态 import 取同一份替身实例
vi.mock("@/lib/ipc-dialog", async () => (await import("@/test/tauri-mock")).ipcDialogMock());
vi.mock("@/lib/ipc-fs", async () => (await import("@/test/tauri-mock")).ipcFsMock());
vi.mock("@/lib/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
// 文案替身：带变量时把变量拼进去，否则 matched/missing 的数量断言不到
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const headers = ["名称", "照片"];
const initialTypes: FieldType[] = ["text", "attachment"];
const dataRows = [
  ["甲", "a.png|gone.png"],
  ["乙", "b.png"],
];

const onCancel = vi.fn();
const onConfirm = vi.fn();

beforeEach(() => {
  cleanup();
  resetIpcMock();
  onCancel.mockClear();
  onConfirm.mockClear();
  // 顶层一个文件 + 一个子目录里的同名规则文件：递归扫描与「小写文件名 → 绝对路径」都靠它
  setFsDir("D:/attachments", [
    { name: "a.png", isFile: true },
    { name: "sub", isDirectory: true },
  ]);
  setFsDir("D:/attachments/sub", [{ name: "b.png", isFile: true }]);
});

describe("CsvImportDialog 的附件文件夹选择", () => {
  it("选完目录后递归收集子目录文件，统计与索引都落到确认回调里", async () => {
    const user = userEvent.setup();
    queueOpenDialog("D:\\attachments");

    render(
      <CsvImportDialog
        headers={headers}
        initialTypes={initialTypes}
        dataRows={dataRows}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole("button", { name: "csv.attachment.chooseFolder" }));

    await waitFor(() => expect(screen.getByText("attachments")).toBeTruthy());
    // a.png + b.png 命中、gone.png 缺
    expect(screen.getByText('csv.attachment.stats {"matched":2,"missing":1}')).toBeTruthy();
    // recursive 必须带着：没有它，对话框不会把子树写进 fs scope，子目录文件读不到
    expect(dialogCalls[0]).toEqual({ kind: "open", options: { directory: true, multiple: false, recursive: true } });

    await user.click(screen.getByRole("button", { name: "csv.import" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [types, foldersByColumn, target] = onConfirm.mock.calls[0] as [
      FieldType[],
      Record<number, Record<string, string>>,
      "new" | "current",
    ];
    expect(types).toEqual(initialTypes);
    expect(target).toBe("new");
    expect(foldersByColumn[1]).toEqual({ "a.png": "D:/attachments/a.png", "b.png": "D:/attachments/sub/b.png" });
  });

  it("用户取消对话框时不扫目录，界面停在「未选择」", async () => {
    const user = userEvent.setup();
    queueOpenDialog(null);

    render(
      <CsvImportDialog
        headers={headers}
        initialTypes={initialTypes}
        dataRows={dataRows}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole("button", { name: "csv.attachment.chooseFolder" }));

    await waitFor(() => expect(dialogCalls).toHaveLength(1));
    expect(readDir).not.toHaveBeenCalled();
    expect(screen.getByText("csv.attachment.noFolder")).toBeTruthy();
    // 没选目录时三个名字都算缺，界面照旧给出统计而不是静默
    expect(screen.getByText('csv.attachment.stats {"matched":0,"missing":3}')).toBeTruthy();
  });
});
