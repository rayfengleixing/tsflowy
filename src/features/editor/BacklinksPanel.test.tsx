// @vitest-environment jsdom
// 反链面板从 EditorPage.tsx 切出来时是「搬不改」，但搬出来的那一刻它第一次变成可单独渲染的东西，
// 于是这几条用例能钉住原来只能靠肉眼在原生窗口里看的行为：分组、每组只露三条但计数是全量、
// 收起与专注模式都只藏渲染不丢数据（面板一直挂载，所以切页才不会重拉）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BacklinksPanel } from "./BacklinksPanel";
import { callsFor, resetIpcMock, setIpcHandlers } from "@/test/tauri-mock";
import type { BacklinkRow } from "@/lib/doc/mentions";
import type { View } from "@/types/models";

vi.mock("@/lib/ipc/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
// 只关心 key 与传入的变量：标题那个「被 N 个页面引用」要能读出 N
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));

// 面板只用到 openView（点来源名、点上下文行都走它），替身记下来即可
const ws = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/stores/workspace", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    openView: (id: string) => {
      ws.opened.push(id);
    },
  }));
  return { useWorkspaceStore: store };
});

const viewOf = (id: string): View => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  name: `来源-${id}`,
  icon: null,
  layout: "document",
  extra: "{}",
  position: 0,
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
const rowOf = (srcViewId: string, n: number): BacklinkRow => ({
  id: `m-${srcViewId}-${n}`,
  src_view_id: srcViewId,
  target_view_id: "v-here",
  context_text: `上下文-${srcViewId}-${n}`,
  updated_at: 0,
  src_view: viewOf(srcViewId),
});

/** 「s-1 引用了 4 次、s-2 引用了 1 次」：分组数、每组露出的条数与全量计数三件事都能从这份数据看出来 */
const fourPlusOne = () => [rowOf("s-1", 1), rowOf("s-1", 2), rowOf("s-1", 3), rowOf("s-1", 4), rowOf("s-2", 1)];

const titleButton = () => screen.getByRole("button", { name: /backlinks\.title/ });
// 用 queryAll 而不是 getAll：收起那一刻它就是零条，那正是这条用例要断言的东西
const contextRows = () => screen.queryAllByRole("button", { name: "backlinks.contextLabel" });

beforeEach(() => {
  cleanup();
  resetIpcMock();
  ws.opened.length = 0;
  setIpcHandlers({ mention_list_backlinks: () => fourPlusOne() });
});

describe("BacklinksPanel", () => {
  it("按来源分组：每组最多露三条上下文，计数仍是全量", async () => {
    render(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(screen.queryByText("来源-s-2")).not.toBeNull());

    expect(titleButton().textContent).toContain('backlinks.title {"n":2}');
    // s-1 有 4 条，只露 3 条
    expect(contextRows()).toHaveLength(4);
    expect(screen.queryByText("上下文-s-1-4")).toBeNull();
    // 但组尾的计数按全量写
    expect(screen.queryByText("· 4")).not.toBeNull();
    expect(screen.queryByText("· 1")).not.toBeNull();
  });

  it("查的是当前文档：viewId 作为 targetViewId 发给命令", async () => {
    render(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(callsFor("mention_list_backlinks")).toHaveLength(1));

    expect(callsFor("mention_list_backlinks")[0].args).toEqual({ targetViewId: "v-here" });
  });

  it("点来源名和点上下文行都跳到那个来源页", async () => {
    const user = userEvent.setup();
    render(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(screen.queryByText("来源-s-1")).not.toBeNull());

    await user.click(screen.getByText("来源-s-1"));
    await user.click(contextRows()[0]);

    expect(ws.opened).toEqual(["s-1", "s-1"]);
  });

  it("收起只藏列表：标题还在，再展开不用重拉（面板一直挂载）", async () => {
    const user = userEvent.setup();
    render(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(contextRows()).toHaveLength(4));

    await user.click(titleButton());
    expect(contextRows()).toHaveLength(0);
    expect(titleButton().textContent).toContain("backlinks.title");

    await user.click(titleButton());
    expect(contextRows()).toHaveLength(4);
    expect(callsFor("mention_list_backlinks")).toHaveLength(1);
  });

  it("专注模式整块不渲染，但数据已经拉过；切回来时不重拉", async () => {
    const { rerender } = render(<BacklinksPanel viewId="v-here" hidden />);
    await waitFor(() => expect(callsFor("mention_list_backlinks")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /backlinks\.title/ })).toBeNull();

    rerender(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(contextRows()).toHaveLength(4));
    expect(callsFor("mention_list_backlinks")).toHaveLength(1);
  });

  it("没有反链时不占位；换文档先清空，旧文档的反链不会短暂残留", async () => {
    setIpcHandlers({
      mention_list_backlinks: (args) => (args?.targetViewId === "v-here" ? fourPlusOne() : []),
    });
    const { rerender } = render(<BacklinksPanel viewId="v-none" hidden={false} />);
    await waitFor(() => expect(callsFor("mention_list_backlinks")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /backlinks\.title/ })).toBeNull();

    rerender(<BacklinksPanel viewId="v-here" hidden={false} />);
    await waitFor(() => expect(contextRows()).toHaveLength(4));

    // 换走的那一刻：effect 同步清了旧数据，新文档的命令是异步的，所以这里既不是旧值也不是半旧半新
    rerender(<BacklinksPanel viewId="v-none" hidden={false} />);
    expect(contextRows()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /backlinks\.title/ })).toBeNull();
    await waitFor(() => expect(callsFor("mention_list_backlinks")).toHaveLength(3));
  });
});
