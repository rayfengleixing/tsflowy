// @vitest-environment jsdom
// 跨空间搬页弹窗：落点清单来自「另一个空间的真实树」，最容易错的是把 parentId
// 传成空间 id、或切换空间后还拿着上一个空间的页面列表 —— 只能真点一遍才看得出来。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  listByWorkspace: vi.fn(),
  moveToWorkspace: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({ viewApi: { listByWorkspace: h.listByWorkspace } }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      workspaces: [
        { id: "w1", name: "当前空间" },
        { id: "w2", name: "工作笔记" },
        { id: "w3", name: "个人资料" },
      ],
      currentWorkspaceId: "w1",
      moveViewToWorkspace: h.moveToWorkspace,
    }),
}));

import { MoveToSpaceDialog } from "./move-to-space-dialog";
import type { View } from "@/types/models";

const v = (id: string, parent_id: string | null, position: number): View => ({
  id,
  workspace_id: "w2",
  parent_id,
  name: id,
  icon: null,
  layout: "document",
  extra: "{}",
  position,
  is_favorite: 0,
  is_trash: 0,
  deleted_at: null,
  created_at: 0,
  updated_at: 0,
  visited_at: null,
  source_id: null,
  tags: "[]",
  aliases: "[]",
});

beforeEach(() => {
  vi.clearAllMocks();
  h.moveToWorkspace.mockResolvedValue(undefined);
  h.listByWorkspace.mockImplementation((id: string) =>
    Promise.resolve(id === "w2" ? [v("p1", null, 0), v("c1", "p1", 0), v("p2", null, 1)] : []),
  );
});

afterEach(() => cleanup());

function renderDialog() {
  render(<MoveToSpaceDialog view={v("mine", null, 0)} open onOpenChange={vi.fn()} />);
}

describe("搬到其它空间弹窗", () => {
  it("默认落到第一个其它空间，落点给出根级和它的页面树", async () => {
    renderDialog();
    await waitFor(() => expect(h.listByWorkspace).toHaveBeenCalledWith("w2"));
    expect(h.listByWorkspace.mock.calls.length).toBe(1);
    const targets = await screen.findAllByTestId("move-target-parent");
    // 根级 + p1 + c1 + p2，且当前空间自己的页面不在里面
    expect(targets.map((el) => el.textContent)).toEqual(["moveToSpace.rootLevel", "p1", "c1", "p2"]);
  });

  it("选中某个页面后确认，parentId 用的是那个页面 id", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(h.listByWorkspace).toHaveBeenCalled());
    await user.click(screen.getByText("c1"));
    await user.click(screen.getByTestId("move-confirm"));
    await waitFor(() => expect(h.moveToWorkspace).toHaveBeenCalled());
    expect(h.moveToWorkspace.mock.calls[0]).toEqual(["mine", "w2", "c1"]);
  });

  it("换空间重新取落点清单，不会把上一个空间的页面搬过去", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(h.listByWorkspace).toHaveBeenCalledWith("w2"));
    await user.click(screen.getByText("个人资料"));
    await waitFor(() => expect(h.listByWorkspace).toHaveBeenCalledWith("w3"));
    const targets = await screen.findAllByTestId("move-target-parent");
    expect(targets.map((el) => el.textContent)).toEqual(["moveToSpace.rootLevel"]);
    await user.click(screen.getByTestId("move-confirm"));
    await waitFor(() => expect(h.moveToWorkspace).toHaveBeenCalledWith("mine", "w3", null));
  });

  it("被拒绝时（回收站页 / 派生视图）报错但弹窗留着，用户还能改落点", async () => {
    const user = userEvent.setup();
    h.moveToWorkspace.mockRejectedValue(new Error("trashed page cannot be moved"));
    renderDialog();
    await waitFor(() => expect(h.listByWorkspace).toHaveBeenCalled());
    await user.click(screen.getByTestId("move-confirm"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain("moveToSpace.failed");
    expect(screen.getByTestId("move-confirm")).toBeTruthy();
  });
});
