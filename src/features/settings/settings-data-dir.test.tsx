// @vitest-environment jsdom
// 这条用例证明的是收口后的取数口径：整份测试只 mock 一个 IPC 模块（@/lib/ipc-core），
// 组件走的还是真实的 @/lib/invoke 包装层，未注册的命令会直接抛而不是画出一片空白。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SettingsDataDir } from "./SettingsDataDir";
import { callsFor, resetIpcMock, setIpcHandlers } from "@/test/tauri-mock";

// 全篇只 mock 这一个 IPC 模块（vi.mock 工厂里不能引顶层绑定，故用动态 import 取同一份替身实例）
vi.mock("@/lib/ipc/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
// 文案替身：断言用 key，切语言不影响这条用例要证的东西
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetIpcMock();
  setIpcHandlers({
    data_dir_path: () => "D:/TsFlowy/Data",
    get_sync_info: () => ({ dir: "D:/TsFlowy/Sync", last_result: null }),
    get_data_dir_info: () => ({ is_linked: false, link_path: "", custom: null, will_change_after_restart: false }),
    open_data_dir: () => undefined,
  });
});

describe("SettingsDataDir 只靠一个 IPC 替身就能渲染", () => {
  it("挂载后三个读命令各走一次，路径回填到输入框", async () => {
    render(<SettingsDataDir />);

    await waitFor(() => expect(screen.getByDisplayValue("D:/TsFlowy/Data")).toBeTruthy());
    expect(callsFor("data_dir_path")).toHaveLength(1);
    expect(callsFor("get_sync_info")).toHaveLength(1);
    expect(callsFor("get_data_dir_info")).toHaveLength(1);
    // 目录与同步文件夹不嵌套、也不在云盘里 → 不该有风险条
    expect(screen.queryByText("settings.dataDirRiskCloud")).toBeNull();
    expect(screen.queryByText("settings.dataDirRiskOverlap")).toBeNull();
  });

  it("数据目录落在 OneDrive 里时，风险条来自真实的 detectDataDirRisk", async () => {
    setIpcHandlers({ data_dir_path: () => "C:/Users/Fang/OneDrive/TsFlowy/Data" });

    render(<SettingsDataDir />);

    await waitFor(() => expect(screen.getByText("settings.dataDirRiskCloud")).toBeTruthy());
  });

  it("点「打开目录」把命令名带到 Rust 边界", async () => {
    const user = userEvent.setup();
    render(<SettingsDataDir />);
    await waitFor(() => expect(screen.getByDisplayValue("D:/TsFlowy/Data")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "settings.openDir" }));

    await waitFor(() => expect(callsFor("open_data_dir")).toHaveLength(1));
  });
});
