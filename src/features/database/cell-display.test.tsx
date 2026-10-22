// @vitest-environment jsdom
// url / email 单元格的「点一下交给系统打开」跨了两层：协议白名单在 database-link.ts，
// 出口在 @/lib/ipc-shell 的 openUrl。真机点了才弹浏览器，jsdom 里只能把 openUrl 换成替身，
// 断言「递给边界的到底是哪个地址」——这恰好是白名单唯一能被外部观察到的地方。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CellLink } from "./cell-display";
import { failNextOpenUrl, openUrl, openedUrls, resetIpcMock } from "@/test/tauri-mock";

// vi.mock 会被提到文件最前，工厂里用动态 import 取同一份替身实例
vi.mock("@/lib/ipc-shell", async () => (await import("@/test/tauri-mock")).ipcShellMock());
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

beforeEach(() => {
  cleanup();
  resetIpcMock();
  toastError.mockReset();
});

describe("CellLink 的打开动作", () => {
  it("没写协议的网址补成 https 再交给系统", async () => {
    const user = userEvent.setup();
    render(<CellLink kind="url" value="example.com" />);

    await user.click(screen.getByRole("button", { name: "example.com" }));

    expect(openedUrls).toEqual(["https://example.com/"]);
  });

  it("邮箱加 mailto，尾部空白不进地址", async () => {
    const user = userEvent.setup();
    render(<CellLink kind="email" value=" a@b.example " />);

    await user.click(screen.getByRole("button", { name: "a@b.example" }));

    expect(openedUrls).toEqual(["mailto:a@b.example"]);
  });

  it("白名单外的协议退化成纯文本，点了不打边界", async () => {
    const user = userEvent.setup();
    render(<CellLink kind="url" value="javascript:alert(1)" />);

    expect(screen.queryByRole("button")).toBeNull();
    await user.click(screen.getByText("javascript:alert(1)"));

    expect(openUrl).not.toHaveBeenCalled();
    expect(openedUrls).toEqual([]);
  });

  it("系统拒绝拉起时出声，并且按钮还能再点（busy 有复位）", async () => {
    const user = userEvent.setup();
    failNextOpenUrl("系统拒绝");
    render(<CellLink kind="url" value="https://example.com" />);

    const button = screen.getByRole("button", { name: "https://example.com" });
    await user.click(button);
    expect(toastError).toHaveBeenCalledWith('error.db {"message":"Error: 系统拒绝"}');

    await user.click(button);
    expect(openedUrls).toEqual(["https://example.com/", "https://example.com/"]);
  });
});
