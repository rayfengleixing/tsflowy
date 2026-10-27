// @vitest-environment jsdom
// 这是 AI 动到文档之前的最后一道肉眼闸门：卡片上的「应用」点开它，用户在「原文 / 改为」之间确认一次。
// 它自己没有任何状态，全靠四个 props，所以最容易错的是判定而不是样式——
// 已应用/已忽略的记录不能再出「应用」（点了就是重复落地），插入类动作没有原文要说明而不是给个空框，
// 跨页动作要说清改的是哪一页（否则用户以为改的是眼前这页）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AiActionRecord } from "@/stores/ai";

vi.mock("@/lib/i18n", () => ({
  // 保留 key 便于点名断言，同时把插值变量拼进去——「落点页面：{name}」少了 name 是看不出来的
  t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));

import { EditDiffDialog } from "./EditDiffDialog";

const rec = (over: Partial<AiActionRecord> = {}): AiActionRecord => ({
  tool: "apply_edit",
  call: null,
  op: null,
  summary: "把第三段改短",
  content: "改后的正文",
  before: "改前的正文",
  state: "pending",
  ...over,
});

const noop = () => undefined;

afterEach(() => {
  cleanup();
});

describe("EditDiffDialog 的应用闸门", () => {
  it("只有待确认的记录才给「应用」，且点了就先落地再关窗", () => {
    const applied = vi.fn();
    const changed = vi.fn();
    render(<EditDiffDialog record={rec()} open onOpenChange={changed} onApply={applied} />);
    const btnApply = screen.getByText("ai.applyEdit").closest("button");
    fireEvent.click(btnApply as HTMLElement);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(false);
    // 顺序也是行为：先关窗再落地的话，落地失败时弹窗已经没了，用户看不到提示落在哪
    expect(applied.mock.invocationCallOrder[0]).toBeLessThan(changed.mock.invocationCallOrder[0]);
  });

  it("已应用与已忽略的记录不再给「应用」，取消按钮还在", () => {
    for (const state of ["applied", "rejected", "unavailable", "malformed"] as const) {
      const { unmount } = render(<EditDiffDialog record={rec({ state })} open onOpenChange={noop} onApply={vi.fn()} />);
      expect(screen.queryByText("ai.applyEdit")).toBeNull();
      expect(screen.getByText("common.cancel")).toBeTruthy();
      unmount();
      cleanup();
    }
  });

  it("父层没给 onApply 时不出现一个点了没反应的按钮", () => {
    render(<EditDiffDialog record={rec()} open onOpenChange={noop} />);
    expect(screen.queryByText("ai.applyEdit")).toBeNull();
  });

  it("取消只关窗，不碰落地", () => {
    const applied = vi.fn();
    const changed = vi.fn();
    render(<EditDiffDialog record={rec()} open onOpenChange={changed} onApply={applied} />);
    fireEvent.click(screen.getByText("common.cancel").closest("button") as HTMLElement);
    expect(changed).toHaveBeenCalledWith(false);
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("EditDiffDialog 的对比正文", () => {
  // 弹窗内容走 radix 的 portal，落在 document.body 而不是 render() 返回的 container 里
  const preTexts = () => Array.from(document.querySelectorAll("pre")).map((el) => el.textContent);
  const bodyText = () => document.body.textContent ?? "";

  it("有原文时左右两栏各贴自己的正文，一个字不改", () => {
    render(<EditDiffDialog record={rec({ before: "第一行\n第二行  ", content: "新的" })} open onOpenChange={noop} />);
    expect(preTexts()).toEqual(["第一行\n第二行  ", "新的"]);
    expect(bodyText()).not.toContain("ai.diffNoBefore");
  });

  it("插入类没有原文：左栏换成「无原文」说明，右栏照旧是新内容", () => {
    render(<EditDiffDialog record={rec({ before: "   ", content: "# 周报" })} open onOpenChange={noop} />);
    expect(preTexts()).toEqual(["ai.diffNoBefore", "# 周报"]);
  });

  it("跨页动作要说清落点是哪一页；没说页面名就不出现这一行", () => {
    const { rerender } = render(<EditDiffDialog record={rec({ pageName: "任务清单" })} open onOpenChange={noop} />);
    expect(bodyText()).toContain('ai.actionPage {"name":"任务清单"}');
    expect(bodyText()).toContain("ai.diffTitle");
    rerender(<EditDiffDialog record={rec()} open onOpenChange={noop} />);
    expect(bodyText()).not.toContain("ai.actionPage");
  });

  it("记录还是 null（关闭动画期间父层已清空）时不崩，两栏留空", () => {
    render(<EditDiffDialog record={null} open onOpenChange={noop} />);
    expect(preTexts()).toEqual(["ai.diffNoBefore", ""]);
    expect(screen.queryByText("ai.applyEdit")).toBeNull();
  });
});
