// @vitest-environment jsdom
// 系统级快捷键的录制器：这里最不能错的是「注册失败却把界面改成用户刚按的那条」——
// 那样界面写着生效、系统里其实没抢下来，下次按什么都不会发生。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/app-shell", () => ({
  CAPTURE_SHORTCUT_DEFAULT: { enabled: true, ctrl: true, shift: false, alt: true, key: "t" },
  getCaptureShortcut: h.get,
  setCaptureShortcut: h.set,
}));

import { SettingsCaptureShortcut } from "./SettingsCaptureShortcut";

const current = { enabled: true, ctrl: true, shift: false, alt: true, key: "t" };

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue({ ...current });
  // 命令的返回值才是系统里真的生效的那条，测试里让它原样回显
  h.set.mockImplementation((sc: typeof current) => Promise.resolve({ ...sc }));
});

afterEach(() => cleanup());

async function renderRow() {
  render(<SettingsCaptureShortcut />);
  return screen.findByTestId("capture-record");
}

describe("系统级唤起快捷键", () => {
  it("读回当前绑定：默认那条按 Ctrl / ⌘ + Alt + T 展示", async () => {
    const button = await renderRow();
    await waitFor(() => expect(button.textContent).toBe("Ctrl / ⌘ + Alt + T"));
  });

  it("录下新组合键后按 Combo 形状写回，并顺手启用", async () => {
    const user = userEvent.setup();
    const button = await renderRow();
    await waitFor(() => expect(button.textContent).toBe("Ctrl / ⌘ + Alt + T"));
    await user.click(button);
    fireEvent.keyDown(window, { key: "j", ctrlKey: true, altKey: true });
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    expect(h.set.mock.calls[0][0]).toEqual({ enabled: true, ctrl: true, shift: false, alt: true, key: "j" });
    await waitFor(() => expect(screen.getByTestId("capture-record").textContent).toBe("Ctrl / ⌘ + Alt + J"));
  });

  it("只按修饰键不落库，Esc 取消录制", async () => {
    const user = userEvent.setup();
    const button = await renderRow();
    await waitFor(() => expect(button.textContent).toBe("Ctrl / ⌘ + Alt + T"));
    await user.click(button);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    expect(h.set).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    // Esc 只退出录制，绑定一个字节都没动过
    await waitFor(() => expect(screen.getByTestId("capture-record").textContent).toBe("Ctrl / ⌘ + Alt + T"));
    expect(h.set).not.toHaveBeenCalled();
  });

  it("没带 Ctrl/Alt 的组合键被拒，不写库", async () => {
    const user = userEvent.setup();
    const button = await renderRow();
    await waitFor(() => expect(button.textContent).toBe("Ctrl / ⌘ + Alt + T"));
    await user.click(button);
    fireEvent.keyDown(window, { key: "a", shiftKey: true });
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.set).not.toHaveBeenCalled();
  });

  it("注册失败时报错，绑定仍是原来那条（录制留着让人换个组合键重试）", async () => {
    const user = userEvent.setup();
    const button = await renderRow();
    await waitFor(() => expect(button.textContent).toBe("Ctrl / ⌘ + Alt + T"));
    await user.click(button);
    h.set.mockRejectedValueOnce(new Error("快捷键 Control+Alt+K 注册失败"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, altKey: true });
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(button.textContent).toBe("settings.shortcutRecording");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("capture-record").textContent).toBe("Ctrl / ⌘ + Alt + T"));
  });

  it("取消勾选只关掉注册，绑定本身留着；重新勾上还是同一条", async () => {
    const user = userEvent.setup();
    await renderRow();
    const checkbox = screen.getByTestId("capture-enabled");
    await user.click(checkbox);
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    expect(h.set.mock.calls[0][0]).toEqual({ ...current, enabled: false });
    await waitFor(() => expect(screen.getByText("settings.captureOff")).toBeTruthy());

    h.set.mockResolvedValue({ ...current });
    await user.click(checkbox);
    await waitFor(() => expect(h.set.mock.calls.length).toBe(2));
    expect(h.set.mock.calls[1][0]).toEqual(current);
  });

  it("恢复默认写回硬编码那老一条（Ctrl+Alt+T）", async () => {
    h.get.mockResolvedValue({ ...current, key: "j" });
    const user = userEvent.setup();
    await renderRow();
    await waitFor(() => expect(screen.getByTestId("capture-record").textContent).toBe("Ctrl / ⌘ + Alt + J"));
    await user.click(screen.getByTestId("capture-reset"));
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    expect(h.set.mock.calls[0][0]).toEqual({ enabled: true, ctrl: true, shift: false, alt: true, key: "t" });
  });
});
