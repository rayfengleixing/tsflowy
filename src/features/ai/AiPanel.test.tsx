// @vitest-environment jsdom
// AiPanel 是编排层：它自己不发请求、不改文档，管的是「store 的状态摊成界面上的闸门」。
// J 批把历史弹层与输入区切出去以后，它剩下的就是这一层，所以这几条盯的都是切分与后续搬动最容易悄悄坏的东面：
// 三个空态的分岔（还没加载 / 没配好 / 已配好）、头部那排按钮各自的 disabled 条件、流式期间「在忙什么」那一行、
// 上滑之后不再被拽回底部、拖宽结束后把 window 监听摘掉、破坏性操作必须过确认框且两型各走各的动作，
// 以及递给气泡的那只 api 对象引用稳定（逐个内联箭头会击穿气泡的 memo，流式每来一个 token 全量重渲）。
// 子件一律换成替身：`MessageBubble.test.tsx` / `EditDiffDialog.test.tsx` / `AiParts.test.tsx` /
// `SessionHistoryPopover.test.tsx` / `AiComposer.test.tsx` 各盯自己那层的形状，这里只钉「面板有没有把它们接对」。
// 文案用 key 恒等替身（`@/lib/i18n`）：断的是走了哪条分支，不是中文措辞。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RefObject } from "react";

import { AiPanel } from "./AiPanel";
import { useAiStore } from "@/stores/ai";
import type { AiActionRecord, AiMessage, StoredSession } from "@/stores/ai";
import type { AiConfig, AiProfilePublic } from "@/lib/ai";
import type { BubbleApi } from "./MessageBubble";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

/** 面板递给编辑器的桥：null = 没有可回填的文档 */
type BridgeStub = Record<string, ReturnType<typeof vi.fn>> | null;

const h = vi.hoisted(() => ({
  closePanel: vi.fn(),
  setWidth: vi.fn(),
  loadConfig: vi.fn(),
  loadSessions: vi.fn(),
  switchProfile: vi.fn(),
  setCtxScope: vi.fn(),
  runQuickAction: vi.fn(),
  continueGenerate: vi.fn(),
  clear: vi.fn(),
  retry: vi.fn(),
  quickAction: vi.fn(),
  undoAction: vi.fn(),
  newChat: vi.fn(),
  deleteSession: vi.fn(),
  rateMessage: vi.fn(),
  applyAction: vi.fn(),
  rejectAction: vi.fn(),
  regenerate: vi.fn(),
  startEdit: vi.fn(),
  branchFrom: vi.fn(),
  saveMessageAsPage: vi.fn(),
  exportMessage: vi.fn(),
  setRoute: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  bridge: null as BridgeStub,
  /** 金额由 lib/ai 算（形状在 lib/ai.test.ts 钉）；这里只钉面板「算得出才显示」 */
  estimateCost: vi.fn(() => null as number | null),
  /** 替身把收到的 api / busy 原样记下来，供「引用稳定」与「writeBack 走哪条路」那几条查 */
  apis: [] as BubbleApi[],
  busyFlags: [] as boolean[],
  rafQueue: [] as FrameRequestCallback[],
}));

vi.mock("@/stores/ai", async () => {
  const { create } = await import("zustand");
  return {
    useAiStore: create(() => ({
      open: true,
      width: 360,
      messages: [] as AiMessage[],
      sessions: [] as StoredSession[],
      reasoning: "",
      streaming: false,
      retrieving: false,
      error: null as string | null,
      errorCode: null as string | null,
      usage: null as { prompt_tokens: number | null; completion_tokens: number | null } | null,
      usageTotal: { prompt: 0, completion: 0, total: 0 },
      usageSummary: null as { sessions: number; prompt_tokens: number; completion_tokens: number } | null,
      focusTick: 0,
      activeSessionId: "s-1",
      config: null as AiConfig | null,
      configLoaded: false,
      sessionsLoaded: false,
      closePanel: h.closePanel,
      setWidth: h.setWidth,
      loadConfig: h.loadConfig,
      loadSessions: h.loadSessions,
      switchProfile: h.switchProfile,
      setCtxScope: h.setCtxScope,
      runQuickAction: h.runQuickAction,
      continueGenerate: h.continueGenerate,
      clear: h.clear,
      retry: h.retry,
      quickAction: h.quickAction,
      undoAction: h.undoAction,
      newChat: h.newChat,
      deleteSession: h.deleteSession,
      rateMessage: h.rateMessage,
      applyAction: h.applyAction,
      rejectAction: h.rejectAction,
      regenerate: h.regenerate,
      startEdit: h.startEdit,
      branchFrom: h.branchFrom,
      saveMessageAsPage: h.saveMessageAsPage,
      exportMessage: h.exportMessage,
    })),
  };
});

vi.mock("@/stores/workspace", async () => {
  const { create } = await import("zustand");
  return { useWorkspaceStore: create(() => ({ setRoute: h.setRoute })) };
});

vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock("@/lib/ai-editor", () => ({ getAiEditor: () => h.bridge }));
// 真的 `@/lib/ai` 会顺着 invoke → auto-sync 拉到 Tauri 入口（那个模块加载时就读一次配置），
// jsdom 里不需要那台机器：面板用到的是错误文案、金额估算与格式化，后两个的形状由 lib/ai.test.ts 钉
vi.mock("@/lib/ai", () => ({
  aiErrorText: (e: unknown) => String(e),
  estimateAiCost: h.estimateCost,
  formatAiCost: (n: number) => n.toFixed(2),
}));

interface BubbleProps {
  message: AiMessage;
  api: BubbleApi;
  busy: boolean;
}
vi.mock("./MessageBubble", async () => {
  const React = await import("react");
  return {
    MessageBubble: ({ message, api, busy }: BubbleProps) => {
      h.apis.push(api);
      h.busyFlags.push(busy);
      return React.createElement("div", { "data-bubble": message.id }, message.content);
    },
  };
});

interface QuickProps {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}
// 真实的 QuickButton（含 disabled 真点不动）由 AiParts.test.tsx 钉；这里只钉面板传了什么
vi.mock("./AiParts", async () => {
  const React = await import("react");
  return {
    QuickButton: ({ label, disabled, onClick }: QuickProps) =>
      React.createElement("button", { disabled: !!disabled, onClick }, label),
  };
});

interface HistoryProps {
  onClose: () => void;
  onRequestDelete: (id: string) => void;
}
vi.mock("./SessionHistoryPopover", async () => {
  const React = await import("react");
  return {
    SessionHistoryPopover: ({ onClose, onRequestDelete }: HistoryProps) =>
      React.createElement(
        "div",
        { "data-history": "1" },
        React.createElement("button", { onClick: () => onClose() }, "收起历史"),
        React.createElement("button", { onClick: () => onRequestDelete("s-2") }, "删掉月报"),
      ),
  };
});

interface DiffProps {
  record: AiActionRecord | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApply?: () => void;
}
vi.mock("./EditDiffDialog", async () => {
  const React = await import("react");
  return {
    EditDiffDialog: ({ record, open, onOpenChange, onApply }: DiffProps) => {
      if (!open || !record) return null;
      return React.createElement(
        "div",
        { role: "dialog", "aria-label": "改动对比" },
        React.createElement("span", null, record.summary),
        React.createElement("button", { onClick: () => onOpenChange(false) }, "关掉对比"),
        onApply ? React.createElement("button", { onClick: onApply }, "应用这张卡片") : null,
      );
    },
  };
});

interface ConfirmProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  onConfirm: () => void;
}
// 真组件走 radix 的 portal（见 EditDiffDialog.test.tsx 那条教训），这里换成替身只钉「面板递了哪一型」
vi.mock("@/components/confirm-dialog", async () => {
  const React = await import("react");
  return {
    ConfirmDialog: ({ open, onOpenChange, title, description, onConfirm }: ConfirmProps) =>
      open
        ? React.createElement(
            "div",
            { role: "alertdialog", "aria-label": "确认" },
            React.createElement("span", null, title),
            React.createElement("span", null, description ?? ""),
            React.createElement("button", { onClick: () => onOpenChange(false) }, "取消"),
            React.createElement("button", { onClick: onConfirm }, "确认"),
          )
        : null,
  };
});

interface ComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
}
// 输入区自己那堆（Enter 发送、@ 候选、附件）归 AiComposer.test.tsx；这里要的是它手里那两根线：
// ref 真接到 textarea（从编辑器唤起要 focus）、input 真来自宿主（改提问要回填原文）
vi.mock("./AiComposer", async () => {
  const React = await import("react");
  return {
    AiComposer: ({ textareaRef, input }: ComposerProps) =>
      React.createElement("textarea", { "aria-label": "输入区", ref: textareaRef, value: input, readOnly: true }),
  };
});

const msg = (id: string, role: AiMessage["role"], content: string): AiMessage => ({ id, role, content });

const sessionOf = (id: string, title: string): StoredSession => ({
  id,
  title,
  updatedAt: 0,
  messages: [msg(`${id}-m`, "user", `${title} 的正文`)],
});

const profileOf = (id: string, over: Partial<AiProfilePublic> = {}): AiProfilePublic => ({
  id,
  name: id === "p-fast" ? "快档" : "",
  base_url: "",
  model: "gpt-x",
  temperature: 0.7,
  protocol: "",
  has_api_key: false,
  api_key_masked: "",
  ...over,
});

/**
 * 面板读得到的那几项给默认值，其余按 AiConfig 必填补齐。
 * 不 import `@/test/ai-store-harness` 的 defaultConfig：那个模块在导入时就注册了自己的
 * 全局 beforeEach（要它内部绑定好的 mock 包），组件用例引进来会把别的文件拖下水。
 */
const baseConfig = (over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true,
  provider: "custom",
  protocol: "",
  base_url: "https://api.example.com/v1",
  model: "some-model",
  max_chars: 8000,
  confirm_edit: true,
  temperature: 0.7,
  thinking: "auto",
  ctx_token_budget: 3000,
  ctx_max_messages: 40,
  ctx_scope: "full",
  max_tokens: 0,
  system_prompt: "",
  profiles: [],
  active_profile: "",
  quick_actions: [],
  use_tools: false,
  price_input: 0,
  price_output: 0,
  agent_rounds: 4,
  first_byte_timeout: 30,
  idle_timeout: 120,
  stream_retries: 2,
  has_api_key: true,
  api_key_masked: "sk-***",
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

const READY = {
  open: true,
  width: 360,
  messages: [] as AiMessage[],
  sessions: [] as StoredSession[],
  reasoning: "",
  streaming: false,
  retrieving: false,
  error: null,
  errorCode: null,
  usage: null,
  usageTotal: { prompt: 0, completion: 0, total: 0 },
  usageSummary: null,
  focusTick: 0,
  activeSessionId: "s-1",
  config: baseConfig(),
  configLoaded: true,
  sessionsLoaded: true,
};

const setAi = (patch: Record<string, unknown>) => {
  (useAiStore.setState as (p: unknown) => void)(patch);
};

/** 挂载 = 先把 store 复位到「配好了、没在流式」，再按这条用例要的状态覆盖 */
const mount = (patch: Record<string, unknown> = {}) => {
  setAi({ ...READY, ...patch });
  return render(<AiPanel />);
};

/** 用例中途改状态：包在 act 里，否则 React 的告警会淹掉真正的失败 */
const patch = (p: Record<string, unknown>) => {
  act(() => {
    setAi(p);
  });
};

const headerBtn = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
const listEl = () => screen.getByRole("log");

const lastApi = (): BubbleApi => {
  if (h.apis.length === 0) throw new Error("面板没渲染出任何气泡，拿不到递给它的 api");
  return h.apis[h.apis.length - 1];
};

/** jsdom 没有布局：滚动几何要自己钉，否则「距底 48px 容差」这条判定断不出方向 */
function fakeScroll(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

/** fillInput 把光标移到末尾挂在 requestAnimationFrame 上：钉成手动队列，用例自己决定何时落地 */
const flushRaf = () => {
  act(() => {
    const queued = [...h.rafQueue];
    h.rafQueue.length = 0;
    for (const cb of queued) cb(0);
  });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.apis.length = 0;
  h.busyFlags.length = 0;
  h.rafQueue.length = 0;
  h.bridge = null;
  h.estimateCost.mockImplementation(() => null);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    h.rafQueue.push(cb);
    return h.rafQueue.length;
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.writeText } });
  setAi(READY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("面板在不在，以及开面板要补的两次加载", () => {
  it("收起状态下整块不渲染（连确认框与 diff 弹窗也不留）", () => {
    mount({ open: false });
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("打开时才拉配置与历史会话，已经加载过的不重复拉", () => {
    mount({ configLoaded: false, sessionsLoaded: false });
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
    expect(h.loadSessions).toHaveBeenCalledTimes(1);
    patch({ configLoaded: true, sessionsLoaded: true });
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
    expect(h.loadSessions).toHaveBeenCalledTimes(1);
  });
});

describe("三个空态各归各", () => {
  it("配置还没到手时只有加载中，不给快捷区", () => {
    mount({ configLoaded: false, config: null });
    expect(screen.getByText("app.loading")).toBeTruthy();
    expect(screen.queryByText("ai.summarize")).toBeNull();
  });

  it("没配好连接就是未配置态：开关、地址、模型缺一个都算，且不渲染会话区", () => {
    const broken: Partial<AiConfig>[] = [{ enabled: false }, { base_url: "" }, { model: "" }];
    for (const over of broken) {
      cleanup();
      mount({ config: baseConfig(over) });
      expect(screen.getByText("ai.notConfigured")).toBeTruthy();
      expect(screen.getByText("ai.notConfiguredHint")).toBeTruthy();
      // 未配置时连消息列表都不该出现：那排快捷按钮点下去只会失败的请求
      expect(screen.queryByText("ai.summarize")).toBeNull();
      expect(screen.queryByRole("log")).toBeNull();
    }
  });

  it("未配置态那颗按钮把人送去设置", () => {
    mount({ config: baseConfig({ enabled: false }) });
    fireEvent.click(headerBtn("ai.goSettings"));
    expect(h.setRoute).toHaveBeenCalledWith("settings");
  });

  it("配好了才谈消息：空列表给占位，隐私提示里的服务商取 base_url 的主机名", () => {
    mount({ messages: [], config: baseConfig({ base_url: "https://api.example.com/v1" }) });
    expect(screen.getByText("ai.empty")).toBeTruthy();
    expect(screen.getByText('ai.sendHint:{"host":"api.example.com"}')).toBeTruthy();
    // 解析不了的地址不猜：原样显示，别把一个看不懂的串藏成「未知服务商」
    patch({ config: baseConfig({ base_url: "本地网关" }) });
    expect(screen.getByText('ai.sendHint:{"host":"本地网关"}')).toBeTruthy();
  });
});

describe("流式期间界面说什么", () => {
  it("在忙什么那一行只看检索与有没有思考正文：检索中、思考中、都不说", () => {
    mount({ streaming: true, retrieving: true, reasoning: "" });
    expect(screen.getByText("ai.toolRunning")).toBeTruthy();
    expect(screen.queryByText("ai.thinking")).toBeNull();
    patch({ retrieving: false });
    expect(screen.getByText("ai.thinking")).toBeTruthy();
    // 思考过程自己会展开说话，这行就让位（否则两条并行提示抢同一块地方）
    patch({ reasoning: "先算一步" });
    expect(screen.queryByText("ai.thinking")).toBeNull();
    patch({ streaming: false });
    expect(screen.queryByText("ai.toolRunning")).toBeNull();
  });

  it("思考过程流式时展开，结束后折叠但留着回看", () => {
    const { container } = mount({ streaming: true, reasoning: "先算一步" });
    const box = container.querySelector("details")!;
    expect(box.hasAttribute("open")).toBe(true);
    patch({ streaming: false });
    expect(box.hasAttribute("open")).toBe(false);
    expect(box.textContent).toContain("先算一步");
  });

  it("只有最后一条是 AI 的半截回答才给继续生成", () => {
    mount({ messages: [msg("u1", "user", "问"), msg("a1", "assistant", "半截回答")] });
    fireEvent.click(headerBtn("ai.continueGenerate"));
    expect(h.continueGenerate).toHaveBeenCalledTimes(1);
    // 还在生成中不给了；最后一句是提问时也没什么可续
    patch({ streaming: true });
    expect(screen.queryByRole("button", { name: "ai.continueGenerate" })).toBeNull();
    patch({ streaming: false, messages: [msg("u1", "user", "问")] });
    expect(screen.queryByRole("button", { name: "ai.continueGenerate" })).toBeNull();
  });
});

describe("失败要说清现象、类别和重试", () => {
  it("错误按归类码给出对应的处理办法，认不出的码只说现象", () => {
    mount({ error: "请求失败", errorCode: "timeout" });
    expect(screen.getByText('ai.errorPrefix:{"message":"请求失败"}')).toBeTruthy();
    expect(screen.getByText("ai.errorHintTimeout")).toBeTruthy();
    fireEvent.click(headerBtn("ai.retry"));
    expect(h.retry).toHaveBeenCalledTimes(1);
    patch({ errorCode: "weird-code" });
    expect(screen.getByText('ai.errorPrefix:{"message":"请求失败"}')).toBeTruthy();
    expect(screen.queryByText("ai.errorHintTimeout")).toBeNull();
    patch({ errorCode: null });
    expect(screen.queryByText(/ai\.errorHint/)).toBeNull();
  });
});

describe("头部那排按钮各自的闸门", () => {
  it("没历史、没消息、没可复制的回答时，那三颗点不动", () => {
    mount();
    expect(headerBtn("ai.history").disabled).toBe(true);
    expect(headerBtn("ai.clear").disabled).toBe(true);
    expect(headerBtn("ai.copy").disabled).toBe(true);
    patch({ sessions: [sessionOf("s-2", "月报")], messages: [msg("a1", "assistant", "乙")] });
    expect(headerBtn("ai.history").disabled).toBe(false);
    expect(headerBtn("ai.clear").disabled).toBe(false);
    expect(headerBtn("ai.copy").disabled).toBe(false);
  });

  it("复制的是最后一条**有正文**的回答，不是最后一条消息", async () => {
    mount({
      messages: [
        msg("a1", "assistant", "甲"),
        msg("u1", "user", "追问"),
        msg("a2", "assistant", "乙"),
        msg("a3", "assistant", "   "),
      ],
    });
    fireEvent.click(headerBtn("ai.copy"));
    expect(h.writeText).toHaveBeenCalledWith("乙");
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("ai.copied"));
  });

  it("新对话与收起各打各的动作", () => {
    mount();
    fireEvent.click(headerBtn("ai.newChat"));
    fireEvent.click(headerBtn("ai.close"));
    expect(h.newChat).toHaveBeenCalledTimes(1);
    expect(h.closePanel).toHaveBeenCalledTimes(1);
  });

  it("从编辑器唤起时把光标交给输入框，没唤起（0）不抢焦点", () => {
    mount();
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "输入区" }));
    patch({ focusTick: 1 });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "输入区" }));
  });
});

describe("历史弹层与两道破坏性确认", () => {
  it("弹层的开关归宿主：点了才出现，收起后不渲染", () => {
    mount({ sessions: [sessionOf("s-2", "月报")] });
    expect(screen.queryByText("收起历史")).toBeNull();
    fireEvent.click(headerBtn("ai.history"));
    fireEvent.click(headerBtn("收起历史"));
    expect(screen.queryByText("收起历史")).toBeNull();
  });

  it("删会话这一型：确认框带会话标题，确认后只打 deleteSession", () => {
    mount({ sessions: [sessionOf("s-2", "月报")] });
    fireEvent.click(headerBtn("ai.history"));
    fireEvent.click(headerBtn("删掉月报"));
    expect(screen.getByText("ai.confirmDeleteSessionTitle")).toBeTruthy();
    expect(screen.getByText('ai.confirmDeleteSessionDesc:{"title":"月报"}')).toBeTruthy();
    fireEvent.click(headerBtn("确认"));
    expect(h.deleteSession).toHaveBeenCalledWith("s-2");
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("清空这一型：不确认就一个都不打，确认了才动当前会话", () => {
    mount({ messages: [msg("a1", "assistant", "乙")] });
    fireEvent.click(headerBtn("ai.clear"));
    expect(screen.getByText("ai.confirmClearTitle")).toBeTruthy();
    fireEvent.click(headerBtn("取消"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.clear).not.toHaveBeenCalled();
    fireEvent.click(headerBtn("ai.clear"));
    fireEvent.click(headerBtn("确认"));
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.deleteSession).not.toHaveBeenCalled();
  });
});

describe("跟随底部与拖宽", () => {
  it("停在底部才自动跟随；上滑后不再强拉，并给一颗回到底部", () => {
    mount({ messages: [msg("a1", "assistant", "一")] });
    const list = listEl();
    fakeScroll(list, 900, 300);
    patch({ messages: [msg("a1", "assistant", "一"), msg("a2", "assistant", "二")] });
    expect(list.scrollTop).toBe(900);
    // 距底 600px，超出 48px 容差 → 用户在看历史，流式增量不许再拽他
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(headerBtn("ai.scrollToBottom")).toBeTruthy();
    patch({ messages: [msg("a1", "assistant", "一"), msg("a2", "assistant", "二"), msg("a3", "assistant", "三")] });
    expect(list.scrollTop).toBe(0);
    fireEvent.click(headerBtn("ai.scrollToBottom"));
    expect(list.scrollTop).toBe(900);
    expect(screen.queryByRole("button", { name: "ai.scrollToBottom" })).toBeNull();
  });

  it("换到另一个会话就恢复跟随", () => {
    mount({ messages: [msg("a1", "assistant", "一")] });
    const list = listEl();
    fakeScroll(list, 900, 300);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(headerBtn("ai.scrollToBottom")).toBeTruthy();
    patch({ activeSessionId: "s-9" });
    expect(screen.queryByRole("button", { name: "ai.scrollToBottom" })).toBeNull();
  });

  it("拖左边缘调宽：向左拖变宽，松手后鼠标再动也不跟着改", () => {
    mount({ width: 360 });
    const sep = screen.getByRole("separator");
    fireEvent.mouseDown(sep, { clientX: 1000 });
    fireEvent.mouseMove(window, { clientX: 960 });
    expect(h.setWidth).toHaveBeenCalledWith(400);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(h.setWidth).toHaveBeenCalledTimes(1);
  });
});

describe("快捷区按配置长出来", () => {
  it("模型档位只在配置里真有档位时出现，名字空的退回模型名", () => {
    mount();
    expect(screen.queryByRole("combobox", { name: "settings.aiProfiles" })).toBeNull();
    patch({ config: baseConfig({ profiles: [profileOf("p-fast"), profileOf("p-slow")] }) });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "settings.aiProfiles" });
    expect(select.value).toBe("");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "ai.profileDefault",
      "快档",
      // 没起名的档位不能给一个空白选项
      "gpt-x",
    ]);
    fireEvent.change(select, { target: { value: "p-slow" } });
    expect(h.switchProfile).toHaveBeenCalledWith("p-slow");
  });

  it("上下文范围在面板里直接切，下发的是选中的那个值", () => {
    mount({ config: baseConfig({ ctx_scope: "page_only" }) });
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "ai.ctxScopeTitle" });
    expect(select.value).toBe("page_only");
    fireEvent.change(select, { target: { value: "off" } });
    expect(h.setCtxScope).toHaveBeenCalledWith("off");
  });

  it("五条内置动作 + 用户自定义指令；流式期间整排置灰", () => {
    const custom = { id: "q-1", name: "", prompt: "{content}", scope: "page" as const };
    mount({ config: baseConfig({ quick_actions: [custom] }) });
    for (const label of ["ai.summarize", "ai.translate", "ai.rewrite", "ai.explain", "ai.continue"]) {
      expect(headerBtn(label).disabled).toBe(false);
    }
    // 没名字的自定义指令不出现空按钮
    expect(headerBtn("ai.customAction")).toBeTruthy();
    fireEvent.click(headerBtn("ai.customAction"));
    expect(h.runQuickAction).toHaveBeenCalledWith(custom);
    fireEvent.click(headerBtn("ai.summarize"));
    expect(h.quickAction).toHaveBeenCalledWith("summarize");
    patch({ streaming: true });
    expect(headerBtn("ai.summarize").disabled).toBe(true);
    expect(headerBtn("ai.customAction").disabled).toBe(true);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "ai.ctxScopeTitle" }).disabled).toBe(true);
  });

  it("用量行只在真有数的时候出现，金额算不出来就不显示", () => {
    mount();
    expect(screen.queryByText(/ai\.usageTotal/)).toBeNull();
    patch({
      usageTotal: { prompt: 1000, completion: 0, total: 1000 },
      usage: { prompt_tokens: 900, completion_tokens: 100 },
    });
    expect(screen.getByText('ai.usageTotal:{"total":"1,000"}')).toBeTruthy();
    expect(screen.getByText('ai.usageLast:{"prompt":"900","completion":"100"}')).toBeTruthy();
    // 单价取自设置里的两个字段，本会话累计整个交给它（金额本身怎么算是 lib/ai 的事）
    expect(h.estimateCost).toHaveBeenCalledWith({ prompt: 1000, completion: 0, total: 1000 }, 0, 0);
    expect(screen.queryByText(/ai\.usageCost/)).toBeNull();
    h.estimateCost.mockReturnValue(1);
    patch({ config: baseConfig({ price_input: 1000, price_output: 0 }) });
    expect(h.estimateCost).toHaveBeenLastCalledWith({ prompt: 1000, completion: 0, total: 1000 }, 1000, 0);
    expect(screen.getByText(/ai\.usageCost:{"amount":"1\.00"}/)).toBeTruthy();
  });
});

describe("递给气泡的那只手（bubbleApi）", () => {
  it("api 对象引用稳定，流式增量不击穿气泡的 memo；busy 跟着 streaming", () => {
    mount({ messages: [msg("a1", "assistant", "一")] });
    const first = lastApi();
    expect(h.busyFlags[h.busyFlags.length - 1]).toBe(false);
    patch({ streaming: true, messages: [msg("a1", "assistant", "一"), msg("a2", "assistant", "二")] });
    expect(lastApi()).toBe(first);
    expect(h.busyFlags[h.busyFlags.length - 1]).toBe(true);
  });

  it("回填分两条路；编辑器不在就只提示，一个字符都不写", () => {
    mount({ messages: [msg("a1", "assistant", "一")] });
    const api = lastApi();
    const bridge = { replaceSelection: vi.fn(), insertAtCursor: vi.fn() };
    h.bridge = bridge;
    act(() => {
      api.writeBack("答", "replace");
    });
    expect(bridge.replaceSelection).toHaveBeenCalledWith("答");
    expect(h.toastSuccess).toHaveBeenCalledWith("ai.replaced");
    act(() => {
      api.writeBack("答", "insert");
    });
    expect(bridge.insertAtCursor).toHaveBeenCalledWith("答");
    expect(h.toastSuccess).toHaveBeenCalledWith("ai.inserted");
    h.bridge = null;
    act(() => {
      api.writeBack("答", "replace");
    });
    expect(h.toastError).toHaveBeenCalledWith("ai.noEditor");
    expect(bridge.replaceSelection).toHaveBeenCalledTimes(1);
  });

  it("改提问是两步：标出目标提问，同时把原文填回输入框并把光标放到末尾", () => {
    mount({ messages: [msg("u1", "user", "原提问")] });
    act(() => {
      lastApi().edit(msg("u1", "user", "原提问"));
    });
    expect(h.startEdit).toHaveBeenCalledWith("u1");
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "输入区" });
    expect(field.value).toBe("原提问");
    flushRaf();
    expect(field.selectionStart).toBe(3);
  });

  it("复制空正文不写剪贴板", () => {
    mount({ messages: [msg("a1", "assistant", "一")] });
    act(() => {
      lastApi().copy("   ");
    });
    expect(h.writeText).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("看 diff 开的是**那一张**卡片，重开后应用打新的下标；关掉就收走弹窗", () => {
    mount({ messages: [msg("a1", "assistant", "一"), msg("a2", "assistant", "二")] });
    const rec1 = actionOf({ summary: "第一段" });
    act(() => {
      lastApi().viewDiff("a1", 0, rec1);
    });
    expect(screen.getByRole("dialog", { name: "改动对比" }).textContent).toContain("第一段");
    fireEvent.click(headerBtn("应用这张卡片"));
    expect(h.applyAction).toHaveBeenCalledWith("a1", 0);
    act(() => {
      lastApi().viewDiff("a2", 1, actionOf({ summary: "第二段" }));
    });
    fireEvent.click(headerBtn("应用这张卡片"));
    expect(h.applyAction).toHaveBeenLastCalledWith("a2", 1);
    fireEvent.click(headerBtn("关掉对比"));
    expect(screen.queryByRole("dialog", { name: "改动对比" })).toBeNull();
  });
});
