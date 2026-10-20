// @vitest-environment jsdom
// 全局替换弹窗：这条链路上最不能错的一件事是「先确认、后写库」，
// 以及取消要真的传达到执行循环。两者都是纯逻辑测试看不到、只能真点一遍的。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ runGlobalReplace: vi.fn(), openView: vi.fn(), setRoute: vi.fn() }));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentWorkspaceId: "w1", openView: h.openView, setRoute: h.setRoute }),
}));
vi.mock("./global-replace", () => ({ runGlobalReplace: h.runGlobalReplace }));

import { GlobalReplaceDialog } from "./GlobalReplaceDialog";

const reportOf = (pages: { viewId: string; title: string; replaced: number }[]) => ({
  pages: pages.map((p) => ({ ...p, crossFormat: 0, protectedTitle: 0, blocked: false })),
  replaced: pages.reduce((acc, p) => acc + p.replaced, 0),
  crossFormat: 0,
  protectedTitle: 0,
  candidates: pages.length,
  stopped: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.runGlobalReplace.mockResolvedValue(reportOf([{ viewId: "v1", title: "页面一", replaced: 2 }]));
});

afterEach(() => cleanup());

function renderDialog() {
  render(<GlobalReplaceDialog open onOpenChange={vi.fn()} initialQuery="旧名" />);
}

describe("全局替换弹窗", () => {
  it("「全部替换」先要确认，未确认前一次都不执行", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("replace-apply"));
    expect(h.runGlobalReplace).not.toHaveBeenCalled();
    expect(screen.getByText("search.replace.confirm")).toBeTruthy();

    await user.click(screen.getByText("search.replace.applyConfirm"));
    await waitFor(() => expect(h.runGlobalReplace).toHaveBeenCalled());
    expect(h.runGlobalReplace.mock.calls[0][0]).toMatchObject({ workspaceId: "w1", dryRun: false, search: "旧名" });
  });

  it("预览把命中页面与处数列出来，点一行跳到该页", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("replace-preview"));
    await waitFor(() => expect(screen.getByText("页面一")).toBeTruthy());
    expect(screen.getByText("search.replace.hits")).toBeTruthy();
    expect(h.runGlobalReplace.mock.calls[0][0]).toMatchObject({ dryRun: true });

    await user.click(screen.getByText("页面一"));
    expect(h.openView).toHaveBeenCalledWith("v1");
    expect(h.setRoute).toHaveBeenCalledWith("workspace");
  });

  it("执行途中点取消，取消标记要能被循环读到", async () => {
    const user = userEvent.setup();
    let isCancelled: (() => boolean) | undefined;
    h.runGlobalReplace.mockImplementation((args: { isCancelled?: () => boolean }) => {
      isCancelled = args.isCancelled;
      return new Promise(() => undefined);
    });
    renderDialog();
    await user.click(screen.getByTestId("replace-apply"));
    await user.click(screen.getByText("search.replace.applyConfirm"));
    await waitFor(() => expect(screen.getByTestId("replace-cancel")).toBeTruthy());
    expect(isCancelled?.()).toBe(false);
    await user.click(screen.getByTestId("replace-cancel"));
    expect(isCancelled?.()).toBe(true);
  });
});
