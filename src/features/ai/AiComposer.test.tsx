// @vitest-environment jsdom
// 输入区从 AiPanel.tsx 切出来时是「搬不改」，搬动只碰了它的依赖面：input / mention 两份状态与
// textareaRef 仍归宿主（从编辑器唤起要 focus、气泡「改提问」要 fillInput），其余（附件、@ 候选、
// 快捷键、发送）自持。所以这几条盯的就是接缝本身：Enter 走 send 还是 resend、发送后有没有替宿主
// 把列表拉回底部、@ 候选的键盘优先权、以及流式中那颗「停止」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

import { AiComposer, type AiMention } from "./AiComposer";
import { useAiStore } from "@/stores/ai";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

const ai = vi.hoisted(() => ({
  send: vi.fn(),
  stop: vi.fn(),
  resend: vi.fn(),
  cancelEdit: vi.fn(),
  refinePrompt: vi.fn(),
  clearPromptIdeas: vi.fn(),
  setPendingContext: vi.fn(),
  saveAiImageFile: vi.fn(),
}));

vi.mock("@/stores/ai", async () => {
  const { create } = await import("zustand");
  return {
    useAiStore: create(() => ({
      streaming: false,
      send: ai.send,
      stop: ai.stop,
      resend: ai.resend,
      editingId: null as string | null,
      cancelEdit: ai.cancelEdit,
      promptIdeas: [] as string[],
      clearPromptIdeas: ai.clearPromptIdeas,
      refining: false,
      refinePrompt: ai.refinePrompt,
      pendingContext: null as string | null,
      setPendingContext: ai.setPendingContext,
    })),
  };
});

vi.mock("@/stores/workspace", async () => {
  const { create } = await import("zustand");
  return {
    useWorkspaceStore: create(() => ({
      tree: [
        { id: "v-1", name: "报告", layout: "document", extra: "{}", aliases: "[]", children: [] },
        { id: "v-2", name: "报表", layout: "document", extra: "{}", aliases: "[]", children: [] },
      ],
    })),
  };
});

vi.mock("@/lib/ai", () => ({
  MAX_AI_IMAGES: 3,
  aiErrorText: (e: unknown) => String(e),
  saveAiImageFile: ai.saveAiImageFile,
}));

vi.mock("@/lib/assets/assets", () => ({
  filesFromDataTransfer: (dt: DataTransfer | null) => Array.from(dt?.files ?? []),
  resolveAssetUrl: () => Promise.resolve("asset://stub"),
}));

vi.mock("@/components/view-icon", () => ({ viewIcon: () => "" }));

const pinnedSpy = vi.fn();
const fillSpy = vi.fn();

/** 宿主侧的等价物：input / mention 由宿主持有并传下来，正是 AiPanel 现在的用法 */
function Harness() {
  const [input, setInput] = useState("");
  const [mention, setMention] = useState<AiMention | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <AiComposer
      textareaRef={ref}
      input={input}
      setInput={setInput}
      mention={mention}
      setMention={setMention}
      setPinned={pinnedSpy}
      fillInput={(text) => {
        fillSpy(text);
        setInput(text);
      }}
    />
  );
}

const setAi = (patch: Record<string, unknown>) => {
  (useAiStore.setState as (p: unknown) => void)(patch);
};

const textarea = (): HTMLTextAreaElement => screen.getByRole("textbox", { name: "ai.inputPlaceholder" });
const type = (value: string) => fireEvent.change(textarea(), { target: { value } });
const sendButton = () => screen.getByRole("button", { name: /ai\.send/ });
const options = () => screen.getAllByRole("option");

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  setAi({
    streaming: false,
    editingId: null,
    promptIdeas: [],
    refining: false,
    pendingContext: null,
  });
});

describe("AiComposer", () => {
  it("Enter 发送：走 send(text, undefined)、清空输入、替宿主把列表拉回底部", () => {
    render(<Harness />);
    type("你好");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(ai.send).toHaveBeenCalledWith("你好", undefined);
    expect(textarea().value).toBe("");
    expect(pinnedSpy).toHaveBeenCalledWith(true);
  });

  it("Shift+Enter 只是换行：不发送", () => {
    render(<Harness />);
    type("一行");
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(ai.send).not.toHaveBeenCalled();
  });

  it("空输入且没有附件：发送键禁用，Enter 也不发", () => {
    render(<Harness />);
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(ai.send).not.toHaveBeenCalled();
  });

  it("改提问态：出现提示条，发送走 resend，取消走 cancelEdit 并清空输入", () => {
    setAi({ editingId: "m-9" });
    render(<Harness />);
    expect(screen.getByText("ai.editingBanner")).toBeTruthy();
    type("改后的提问");
    fireEvent.click(sendButton());
    expect(ai.resend).toHaveBeenCalledWith("m-9", "改后的提问", undefined);
    expect(ai.send).not.toHaveBeenCalled();

    type("还在改");
    fireEvent.click(screen.getByRole("button", { name: "ai.cancelMsgEdit" }));
    expect(ai.cancelEdit).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("");
  });

  it("流式中换成「停止」，点它调 stop", () => {
    setAi({ streaming: true });
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /ai\.send/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ai\.stop/ }));
    expect(ai.stop).toHaveBeenCalledTimes(1);
  });

  it("@ 引用：候选来自工作区树，方向键挪高亮，Enter 选中后写回「@名称 」并关掉下拉", () => {
    render(<Harness />);
    type("@报");
    expect(options().map((o) => o.textContent)).toEqual(["报告", "报表"]);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textarea(), { key: "ArrowDown" });
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(textarea().value).toBe("@报表 ");
    expect(screen.queryByRole("listbox")).toBeNull();
    // 选中即把 mention 清掉：再按一次 Enter 就是发送（发送前 text 会被 trim，末尾空格不进请求）
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(ai.send).toHaveBeenCalledWith("@报表", undefined);
  });

  it("「优化提问」候选：点一条填回输入框并清空候选", () => {
    setAi({ promptIdeas: ["改写后的提问"] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "改写后的提问" }));
    expect(fillSpy).toHaveBeenCalledWith("改写后的提问");
    expect(ai.clearPromptIdeas).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("改写后的提问");
  });

  it("编辑器带入的选中内容：显示条数，清掉走宿主的 setPendingContext(null)", () => {
    setAi({ pendingContext: "选中的两段文字" });
    render(<Harness />);
    expect(screen.getByText('ai.pendingContext:{"count":7}')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ai.clearPendingContext" }));
    expect(ai.setPendingContext).toHaveBeenCalledWith(null);
  });
});
