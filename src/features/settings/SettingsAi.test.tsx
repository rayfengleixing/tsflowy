// @vitest-environment jsdom
// AI 设置面板：调优数值是本地模型/自建网关慢时的唯一自救口子，档位与快捷指令是整份配置里的
// 两个数组。这三块已切成子组件，界面接错一根线（或改完没落库）在纯逻辑测试里看不出来，
// 只能真的渲染一遍点一次。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  aiGetConfig: vi.fn(),
  aiSaveConfig: vi.fn(),
  aiListModels: vi.fn(),
  aiTestConnection: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/ai", () => ({ useAiStore: { getState: () => ({ setConfig: api.setConfig }) } }));
vi.mock("@/lib/ai", () => ({
  aiGetConfig: api.aiGetConfig,
  aiSaveConfig: api.aiSaveConfig,
  aiListModels: api.aiListModels,
  aiTestConnection: api.aiTestConnection,
  aiProfileKeyInput: (draft: string) => (draft.trim() === "" ? null : draft.trim()),
  AI_PROVIDER_PRESETS: [{ id: "custom", baseUrl: "" }],
  // 档位行有协议下拉：给全四个真值，才能核对「下拉选中的协议原样进了保存入参」
  AI_PROTOCOL_OPTIONS: ["", "openai", "anthropic", "gemini"],
}));

import { SettingsAi } from "./SettingsAi";

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    provider: "custom",
    protocol: "",
    base_url: "https://api.example.com/v1",
    model: "m",
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
    ...overrides,
  };
}

/** Row 的说明文字与控件不是 for/id 关联的，按「同一行的兄弟节点」取输入框 */
function inputInRow(labelKey: string): HTMLInputElement {
  const row = screen.getByText(labelKey).closest("div.flex")!;
  const el = row.querySelector("input");
  if (!el) throw new Error(`未找到 ${labelKey} 对应的输入框`);
  return el;
}

/** aiSaveConfig 是 mock 出来的，调用参数没有类型；按第 n 次调用收成一条明确的记录 */
function savedAt(n: number): Record<string, unknown> {
  return api.aiSaveConfig.mock.calls[n][0] as Record<string, unknown>;
}

/** aiSaveConfig 是 mock 出来的，调用参数没有类型；断言前收成一条明确的记录 */
function savedInput(): Record<string, unknown> {
  return savedAt(0);
}

/** Row 的说明文字与控件不是 for/id 关联的，按「同一行的兄弟节点」取下拉 */
function selectInRow(labelKey: string): HTMLSelectElement {
  const row = screen.getByText(labelKey).closest("div.flex")!;
  const el = row.querySelector("select");
  if (!el) throw new Error(`未找到 ${labelKey} 对应的下拉`);
  return el;
}

/** 档位卡与快捷指令卡不是 Row 结构：按卡内某个值定位到整张编辑卡 */
function cardBy(value: string): HTMLElement {
  const el = screen.getByDisplayValue(value).closest("div.rounded-md");
  if (!el) throw new Error(`未找到内容含「${value}」的编辑卡`);
  return el as HTMLElement;
}

const inputOf = (root: HTMLElement, selector: string): HTMLInputElement => {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`卡片里没找到 ${selector}`);
  return el;
};

const selectOf = (root: HTMLElement): HTMLSelectElement => {
  const el = root.querySelector<HTMLSelectElement>("select");
  if (!el) throw new Error("卡片里没有下拉");
  return el;
};

/** Rust 回传的档位（Key 只有掩码，绝不明文） */
const serverProfile = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "极速",
  base_url: "https://fast.example.com/v1",
  model: "flash",
  temperature: 0.2,
  protocol: "openai",
  has_api_key: false,
  api_key_masked: "",
  ...overrides,
});

/** 落库入参里只应出现契约声明的那几项，用类型收口后才好按字段断言 */
interface SavedProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  temperature: number;
  protocol: string;
  api_key: string | null;
}

interface SavedAction {
  id: string;
  name: string;
  prompt: string;
  scope: string;
}

const savedProfiles = (n: number): SavedProfile[] => savedAt(n).profiles as SavedProfile[];
const savedActions = (n: number): SavedAction[] => savedAt(n).quickActions as SavedAction[];

beforeEach(() => {
  vi.clearAllMocks();
  api.aiGetConfig.mockResolvedValue(config());
  api.aiSaveConfig.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("AI 设置：网络与 agent 调优", () => {
  it("四个调优项按服务端配置回填", async () => {
    api.aiGetConfig.mockResolvedValue(
      config({ agent_rounds: 6, first_byte_timeout: 90, idle_timeout: 300, stream_retries: 3 }),
    );
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiAgentRounds").value).toBe("6"));
    expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("90");
    expect(inputInRow("settings.aiIdleTimeout").value).toBe("300");
    expect(inputInRow("settings.aiStreamRetries").value).toBe("3");
  });

  it("改首帧等待后离开输入框即整份落库，其余字段原样带回", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.clear(inputInRow("settings.aiFirstByteTimeout"));
    await user.type(inputInRow("settings.aiFirstByteTimeout"), "90");
    await user.tab();

    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    const input = savedInput();
    expect(input.firstByteTimeout).toBe(90);
    // ai_save_config 是覆盖式保存：漏带一项就等于把它重置成默认值
    expect(input.idleTimeout).toBe(120);
    expect(input.agentRounds).toBe(4);
    expect(input.streamRetries).toBe(2);
    expect(input.ctxTokenBudget).toBe(3000);
    expect(input.apiKey).toBeNull();
  });

  it("Key 输入框留空不会清空已存的 Key", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));
    await user.type(inputInRow("settings.aiMaxTokens"), "100");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().apiKey).toBeNull();
  });
});

describe("AI 设置：调优子件的其余字段", () => {
  it("温度改完离开输入框即整份落库，其余采样字段原样带回", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiTemperature").value).toBe("0.7"));

    await user.clear(inputInRow("settings.aiTemperature"));
    await user.type(inputInRow("settings.aiTemperature"), "1.2");
    await user.tab();

    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    const input = savedInput();
    expect(input.temperature).toBe(1.2);
    // 子件只拿到 aiForm 与两个保存回调：任何一根线没接回去，覆盖式保存就把它冲成默认值
    expect(input.maxTokens).toBe(0);
    expect(input.ctxMaxMessages).toBe(40);
    expect(input.priceInput).toBe(0);
    expect(input.priceOutput).toBe(0);
  });

  it("系统提示只在离开输入框时落库（文本框不该边打字边存）", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiTemperature").value).toBe("0.7"));
    const box = screen.getByPlaceholderText("settings.aiSystemPromptPlaceholder");

    await user.type(box, "只答三行");
    expect(api.aiSaveConfig).not.toHaveBeenCalled();

    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().systemPrompt).toBe("只答三行");
  });

  it("思考模式与上下文范围的下拉即时落库，各自只改自己那一项", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiTemperature").value).toBe("0.7"));

    await user.selectOptions(selectInRow("settings.aiThinking"), "off");
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().thinking).toBe("off");
    expect(savedInput().ctxScope).toBe("full");

    await user.selectOptions(selectInRow("settings.aiCtxScope"), "page_only");
    await waitFor(() => expect(api.aiSaveConfig.mock.calls.length).toBeGreaterThan(1));
    expect(savedAt(1).ctxScope).toBe("page_only");
  });
});

describe("AI 设置：模型档位子件", () => {
  it("档位卡的地址/模型/温度/协议四格按服务端配置回填", async () => {
    api.aiGetConfig.mockResolvedValue(config({ profiles: [serverProfile()], active_profile: "p1" }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("极速")).toBeTruthy());

    const card = cardBy("极速");
    expect(inputOf(card, 'input[placeholder="settings.aiModelPlaceholder"]').value).toBe("flash");
    expect(inputOf(card, 'input[placeholder="settings.aiBaseUrlPlaceholder"]').value).toBe(
      "https://fast.example.com/v1",
    );
    expect(inputOf(card, "input[type=number]").value).toBe("0.2");
    expect(selectOf(card).value).toBe("openai");
  });

  it("改档位模型后落库：数组原样带回，服务端字段不混进入参", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(config({ profiles: [serverProfile()], active_profile: "p1" }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("极速")).toBeTruthy());

    const model = inputOf(cardBy("极速"), 'input[placeholder="settings.aiModelPlaceholder"]');
    await user.clear(model);
    await user.type(model, "turbo");
    await user.tab();

    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    // 入参只许带契约里那七项：掩码 / has_api_key 泄进去就是往服务端写脏字段
    expect(savedProfiles(0)).toEqual([
      {
        id: "p1",
        name: "极速",
        base_url: "https://fast.example.com/v1",
        model: "turbo",
        temperature: 0.2,
        protocol: "openai",
        api_key: null,
      },
    ]);
  });

  it("档位 Key：掩码与明文警告跟着 aiConfig，草稿留空不改、填了才覆盖", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(
      config({
        profiles: [
          serverProfile({ has_api_key: true, api_key_masked: "sk-p1" }),
          serverProfile({
            id: "p2",
            name: "稳妥",
            has_api_key: true,
            api_key_masked: "sk-p2",
            api_key_plaintext: true,
          }),
        ],
      }),
    );
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("稳妥")).toBeTruthy());

    // aiConfig 这根线接错的表现：占位文案退回「未存 Key」，掩码行与明文警告整块消失
    const key1 = inputOf(cardBy("极速"), 'input[type="password"]');
    expect(key1.placeholder).toBe("settings.aiProfileKeySavedPlaceholder");
    expect(screen.getByText("settings.aiApiKeySaved：sk-p1")).toBeTruthy();
    expect(screen.getByText("settings.aiApiKeyPlaintextWarn")).toBeTruthy();

    await user.type(key1, "sk-new");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedProfiles(0)[0].api_key).toBe("sk-new");
    // 没填草稿的档位必须是 null：传 "" 会让服务端把该档已存的 Key 清空
    expect(savedProfiles(0)[1].api_key).toBeNull();
    // 落库成功后草稿作废，界面上不留一份「看着像没保存」的明文
    await waitFor(() => expect(inputOf(cardBy("极速"), 'input[type="password"]').value).toBe(""));
  });

  it("删掉当前生效的档位：active 收回单档配置", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(
      config({
        profiles: [serverProfile(), serverProfile({ id: "p2", name: "稳妥" })],
        active_profile: "p1",
      }),
    );
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("稳妥")).toBeTruthy());

    await user.click(cardBy("极速").querySelector<HTMLButtonElement>('button[title="settings.aiRemoveProfile"]')!);
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedProfiles(0).map((p) => p.id)).toEqual(["p2"]);
    expect(savedInput().activeProfile).toBe("");
  });

  it("删掉非当前档位：active 留在原地不动", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(
      config({
        profiles: [serverProfile(), serverProfile({ id: "p2", name: "稳妥" })],
        active_profile: "p1",
      }),
    );
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("稳妥")).toBeTruthy());

    await user.click(cardBy("稳妥").querySelector<HTMLButtonElement>('button[title="settings.aiRemoveProfile"]')!);
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedProfiles(0).map((p) => p.id)).toEqual(["p1"]);
    expect(savedInput().activeProfile).toBe("p1");
  });

  it("加档位：新档继承当前的地址/模型/温度，且不夹带 Key", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByText("settings.aiProfilesEmpty")).toBeTruthy());

    await user.click(screen.getByText("settings.aiAddProfile").closest("button")!);
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedProfiles(0)).toHaveLength(1);
    // 新档 id 由时间戳生成，不参与断言；其余字段必须逐项是「继承来的」而不是空的
    const { id: addedId, ...added } = savedProfiles(0)[0];
    expect(addedId.startsWith("p")).toBe(true);
    expect(added).toEqual({
      name: "settings.aiProfileDefaultName",
      base_url: "https://api.example.com/v1",
      model: "m",
      temperature: 0.7,
      protocol: "",
      api_key: null,
    });
  });
});

describe("AI 设置：自定义快捷指令子件", () => {
  const actions = [
    { id: "q1", name: "摘要", prompt: "总结 {content}", scope: "page" },
    { id: "q2", name: "扩写", prompt: "", scope: "selection" },
  ];

  it("指令卡回填名称/作用范围/提示词", async () => {
    api.aiGetConfig.mockResolvedValue(config({ quick_actions: actions }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("摘要")).toBeTruthy());

    const card = cardBy("摘要");
    expect(selectOf(card).value).toBe("page");
    expect(screen.getByDisplayValue("总结 {content}")).toBeTruthy();
    expect(cardBy("扩写")).toBeTruthy();
  });

  it("改作用范围即时落库并带回整份数组；提示词等离开输入框才存", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(config({ quick_actions: actions }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("摘要")).toBeTruthy());

    await user.selectOptions(selectOf(cardBy("摘要")), "selection");
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedActions(0)).toEqual([
      { id: "q1", name: "摘要", prompt: "总结 {content}", scope: "selection" },
      { id: "q2", name: "扩写", prompt: "", scope: "selection" },
    ]);

    const box = screen.getByDisplayValue("总结 {content}");
    await user.clear(box);
    await user.type(box, "压缩成三行");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig.mock.calls.length).toBeGreaterThan(1));
    expect(savedActions(1)[0].prompt).toBe("压缩成三行");
  });

  it("加指令给的是可编辑的空壳，作用范围默认只吃选区", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByText("settings.aiActionsEmpty")).toBeTruthy());

    await user.click(screen.getByText("settings.aiAddAction").closest("button")!);
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedActions(0)).toHaveLength(1);
    const { id: addedId, ...added } = savedActions(0)[0];
    expect(addedId.startsWith("q")).toBe(true);
    expect(added).toEqual({ name: "settings.aiActionDefaultName", prompt: "", scope: "selection" });
  });

  it("删指令把数组收回整份保存里", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(config({ quick_actions: [actions[0]] }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByDisplayValue("摘要")).toBeTruthy());

    await user.click(cardBy("摘要").querySelector<HTMLButtonElement>('button[title="settings.aiRemoveAction"]')!);
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedActions(0)).toEqual([]);
  });
});
