// @vitest-environment jsdom
// 这条是「接线」证据，不是又一个渲染用例：MessageBubble.test.tsx 把 ./Markdown 换成了替身，那边钉的是
// 「喂进 Markdown 的是哪段正文、喂了几次」；本文件反过来，用**真** Markdown 渲染整条气泡，钉的是
// 「喂进去以后确实被解析」——加粗成 <strong>、表格成 <th>，而不是把星号和竖线原样留在界面上。
// 两边合起来才接得住这条接缝：有人把 `text={bubbleText}` 改成喂 summary、或把助手气泡退成纯文本 div，
// 只有这里会红。
// 第二条钉的是同一段 JSX 的另一半分岔（`MessageBubble.tsx:120-131`）：提问走的是纯文本分支，
// 同一条带 `**` 的正文，在助手气泡里要被解析、在提问气泡里必须原样。
// 最后两条钉围栏：公式与 mermaid 的出图都挂在异步渲染上（形状在 Markdown.test.tsx 钉），
// 这里只确认「气泡把围栏原样交了出去」——正文被谁截短过、或围栏在传 handoff 时丢了，红的是这里。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AiActionRecord, AiMessage } from "@/stores/ai";

const deps = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openRowInView: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  // 签名带上前置的 code：下面那条围栏用例要取出实参，零参替身会让 calls[0][0] 在类型上不存在
  renderTex: vi.fn((_tex: string, _display: boolean) => Promise.resolve("")),
  renderMermaid: vi.fn((_code: string) => Promise.resolve("<svg />")),
}));

// 真 Markdown 的异步出口与提示通道，形状在 Markdown.test.tsx 里钉，这里只挡掉 tauri 与外部包
vi.mock("sonner", () => ({ toast: deps.toast }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/render/katex-render", () => ({ renderTex: deps.renderTex }));
vi.mock("@/lib/render/mermaid-render", () => ({ renderMermaid: deps.renderMermaid }));
vi.mock("@/lib/ipc/ipc-shell", () => ({ openUrl: deps.openUrl }));
vi.mock("@/lib/desktop/deep-link", () => ({ openRowInView: deps.openRowInView }));
vi.mock("@/lib/ai", () => ({ aiErrorText: (e: unknown) => String(e) }));
vi.mock("./AiParts", async () => {
  const React = await import("react");
  return { ImageThumb: ({ path }: { path: string }) => React.createElement("img", { alt: path }) };
});

import { MessageBubble, type BubbleApi } from "./MessageBubble";
import { MATH_CLASS_BLOCK } from "./ai-math";

const apiOf = (): BubbleApi => ({
  copy: vi.fn(),
  regenerate: vi.fn(),
  edit: vi.fn(),
  savePage: vi.fn(),
  exportMsg: vi.fn(),
  branch: vi.fn(),
  rate: vi.fn(),
  writeBack: vi.fn(),
  undo: vi.fn(),
  apply: vi.fn(),
  reject: vi.fn(),
  viewDiff: vi.fn(),
});

const msgOf = (over: Partial<AiMessage> = {}): AiMessage => ({
  id: "m1",
  role: "assistant",
  content: "回答正文",
  ...over,
});

const actionOf = (over: Partial<AiActionRecord> = {}): AiActionRecord => ({
  tool: "apply_edit",
  call: null,
  op: null,
  summary: "把第三段改短",
  content: "改后的正文",
  before: "改前的正文",
  state: "pending",
  ...over,
});

const TABLE = "| 页 | 状态 |\n| --- | --- |\n| 周报 | 已交 |";

afterEach(() => {
  cleanup();
});

describe("气泡交给的是真的 Markdown 渲染", () => {
  it("助手正文里的记号在界面上成标签，星号和竖线不该留着", () => {
    const { container } = render(
      <MessageBubble message={msgOf({ content: `**加粗** 的正文\n\n${TABLE}` })} api={apiOf()} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("加粗");
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelector("tbody")?.textContent).toContain("周报");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("| --- |");
  });

  it("同一条正文是提问时就该原样留着：提问走的是纯文本分支，不解析记号", () => {
    const { container } = render(
      <MessageBubble message={msgOf({ role: "user", content: "**加粗** 的提问" })} api={apiOf()} />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**加粗** 的提问");
  });

  it("卡片与气泡并存时，被解析的只有正文那一段", () => {
    const { container } = render(
      <MessageBubble
        message={msgOf({ content: "**加粗** 的正文", actions: [actionOf({ summary: "把第三段改短" })] })}
        api={apiOf()}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("加粗");
    // 卡片那一行仍是纯文本：说明文字被 Markdown 解析过就等于让 AI 的话参与排版
    expect(container.querySelector("span.min-w-0")?.textContent).toBe("待确认：AI 建议修改文档：把第三段改短");
  });

  it("公式围栏原样交出去：气泡这一路照样打给 KaTeX，出图后仍是块级类名", async () => {
    deps.renderTex.mockResolvedValue('<span class="katex">E=mc²</span>');
    const { container } = render(<MessageBubble message={msgOf({ content: "结论：\n\n$$E=mc^2$$" })} api={apiOf()} />);
    await waitFor(() => expect(deps.renderTex).toHaveBeenCalledWith("E=mc^2", true));
    expect(container.querySelector(`.${MATH_CLASS_BLOCK} .katex`)).toBeTruthy();
  });

  it("mermaid 围栏原样交出去：笔停 350ms 后打给出图，围栏正文一个字没丢", async () => {
    vi.useFakeTimers();
    try {
      deps.renderMermaid.mockResolvedValue('<svg data-mermaid="ok"><path /></svg>');
      const { container } = render(
        <MessageBubble message={msgOf({ content: "```mermaid\ngraph TD; A-->B;\n```" })} api={apiOf()} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect((deps.renderMermaid.mock.calls[0]?.[0] ?? "").trim()).toBe("graph TD; A-->B;");
      expect(container.querySelector('svg[data-mermaid="ok"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
