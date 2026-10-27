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
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: api.toastSuccess, error: api.toastError } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/stores/ai", () => ({ useAiStore: { getState: () => ({ setConfig: api.setConfig }) } }));
vi.mock("@/lib/ai", () => ({
  aiGetConfig: api.aiGetConfig,
  aiSaveConfig: api.aiSaveConfig,
  aiListModels: api.aiListModels,
  aiTestConnection: api.aiTestConnection,
  aiProfileKeyInput: (draft: string) => (draft.trim() === "" ? null : draft.trim()),
  // 预设要给两种形态：带原生协议的（anthropic）与不带的（OpenAI 兼容），才能验「协议回到自动识别」
  AI_PROVIDER_PRESETS: [
    { id: "custom", baseUrl: "", model: "" },
    { id: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
    { id: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-3", protocol: "anthropic" },
  ],
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

describe("AI 设置：父级连接区（没切成子件的那几块）", () => {
  /** 三个开关是 `<label><input/>{文案}</label>` 结构，控件与文案靠父子关系定位 */
  const checkboxOf = (labelKey: string): HTMLInputElement => {
    const el = screen.getByText(labelKey).closest("label")?.querySelector<HTMLInputElement>("input");
    if (!el) throw new Error(`未找到「${labelKey}」对应的复选框`);
    return el;
  };

  /** Row 里的按钮（测试连接 / 拉取模型）按标题文案定位 */
  const buttonNamed = (text: string): HTMLButtonElement => {
    const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text));
    if (!el) throw new Error(`未找到文案含「${text}」的按钮`);
    return el;
  };

  /** 谁先谁后是有语义的：Rust 侧读的是持久化配置，没先落库就等于测的是上一次的连接 */
  const savedBefore = (later: () => number) => {
    expect(api.aiSaveConfig.mock.invocationCallOrder[0]).toBeLessThan(later());
  };

  it("首帧拉到配置：界面回填，同一份原样交给 AI store", async () => {
    const cfg = config({ model: "gpt-x", max_chars: 12000 });
    api.aiGetConfig.mockResolvedValue(cfg);
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiMaxChars").value).toBe("12000"));
    expect(screen.getByDisplayValue("gpt-x")).toBeTruthy();
    // 面板里的截断上限、快捷动作读数都从这条 setConfig 来，接错就成了「设置改了、面板没换」
    expect(api.setConfig).toHaveBeenCalledWith(cfg);
  });

  it("选带原生协议的服务商：地址、模型、协议三项一起带过去", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.selectOptions(selectInRow("settings.aiProvider"), "anthropic");
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().provider).toBe("anthropic");
    expect(savedInput().baseUrl).toBe("https://api.anthropic.com");
    expect(savedInput().model).toBe("claude-3");
    expect(savedInput().protocol).toBe("anthropic");
  });

  it("选 OpenAI 兼容的服务商：协议收回自动识别，而不是留着上一家的原生协议", async () => {
    const user = userEvent.setup();
    api.aiGetConfig.mockResolvedValue(config({ provider: "anthropic", protocol: "anthropic" }));
    render(<SettingsAi />);
    await waitFor(() => expect(selectInRow("settings.aiProvider").value).toBe("anthropic"));

    await user.selectOptions(selectInRow("settings.aiProvider"), "deepseek");
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().baseUrl).toBe("https://api.deepseek.com");
    expect(savedInput().protocol).toBe("");
  });

  it("服务商下拉里没有的历史值：收回 custom 再落库，而不是把野值原样存回去", async () => {
    const user = userEvent.setup();
    // 直接断 select.value 是断不出来的：jsdom 里 value 指向不存在的选项会退回首个选项，改不改兜底都一样
    // 「显示成自定义」。真正的代价在落库那一步——野值会被原样写回服务端，下次读取就对不上任何预设。
    api.aiGetConfig.mockResolvedValue(config({ provider: "ollama", base_url: "http://localhost:11434/v1" }));
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiModel").value).toBe("m"));

    await user.clear(inputInRow("settings.aiMaxChars"));
    await user.type(inputInRow("settings.aiMaxChars"), "9000");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().provider).toBe("custom");
    // 收回 id 的同时不能顺手把地址与模型洗掉：那是本地 Ollama 唯一的接线信息
    expect(savedInput().baseUrl).toBe("http://localhost:11434/v1");
    expect(savedInput().model).toBe("m");
  });

  it("协议族可单独改，只动 protocol 这一项", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.selectOptions(selectInRow("settings.aiProtocol"), "gemini");
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().protocol).toBe("gemini");
    expect(savedInput().provider).toBe("custom");
    expect(savedInput().model).toBe("m");
  });

  it("全局 Key：填了才覆盖，落库成功后输入框清空", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));
    const key = inputInRow("settings.aiApiKey");
    expect(key.placeholder).toBe("settings.aiApiKeyPlaceholderSaved");
    expect(screen.getByText("settings.aiApiKeySaved：sk-***")).toBeTruthy();

    await user.type(key, "sk-global");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().apiKey).toBe("sk-global");
    await waitFor(() => expect(inputInRow("settings.aiApiKey").value).toBe(""));
  });

  it("Key 还没存过时给的是「未设置」占位，且不出掩码行", async () => {
    api.aiGetConfig.mockResolvedValue(config({ has_api_key: false, api_key_masked: "" }));
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiApiKey").placeholder).toBe("settings.aiApiKeyPlaceholderEmpty"));
    expect(screen.queryByText(/^settings\.aiApiKeySaved/)).toBeNull();
  });

  it("凭据库不可用：Key 明文躺在 config.json 里要提示出来", async () => {
    api.aiGetConfig.mockResolvedValue(config({ has_api_key: true, api_key_plaintext: true }));
    render(<SettingsAi />);
    await waitFor(() => expect(screen.getByText("settings.aiApiKeyPlaintextWarn")).toBeTruthy());
  });

  it("上下文上限改完离开输入框即落库", async () => {
    const user = userEvent.setup();
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiMaxChars").value).toBe("8000"));

    await user.clear(inputInRow("settings.aiMaxChars"));
    await user.type(inputInRow("settings.aiMaxChars"), "16000");
    await user.tab();
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().maxChars).toBe(16000);
    expect(savedInput().confirmEdit).toBe(true);
    expect(savedInput().useTools).toBe(false);
  });

  it("启用、改前确认、工具调用三个开关各只翻自己那一项，且改动会被下一次保存带走", async () => {
    const user = userEvent.setup();
    // aiSaveConfig 是覆盖式的：下一份入参得把上一次改的值带回去。无状态的桩做不到这件事，
    // 所以这里给这条用例装一台最小假服务端——保存写进 state，读取回 state（字段名按服务端契约换蛇形）。
    const state: Record<string, unknown> = { ...config() };
    const toServer: Record<string, string> = {
      enabled: "enabled",
      confirmEdit: "confirm_edit",
      useTools: "use_tools",
    };
    api.aiGetConfig.mockImplementation(() => Promise.resolve({ ...state }));
    api.aiSaveConfig.mockImplementation((input: Record<string, unknown>) => {
      for (const [form, wire] of Object.entries(toServer)) state[wire] = input[form];
      return Promise.resolve();
    });

    render(<SettingsAi />);
    await waitFor(() => expect(checkboxOf("settings.aiEnable").checked).toBe(true));

    await user.click(checkboxOf("settings.aiEnable"));
    await waitFor(() => expect(api.aiSaveConfig).toHaveBeenCalled());
    expect(savedInput().enabled).toBe(false);
    expect(savedInput().confirmEdit).toBe(true);
    expect(savedInput().useTools).toBe(false);

    await user.click(checkboxOf("settings.aiConfirmEdit"));
    await waitFor(() => expect(api.aiSaveConfig.mock.calls.length).toBeGreaterThan(1));
    // enabled 必须仍是 false：落库后表单是从服务端配置回填的，回填没接好就会被下一份入参悄悄改回去
    expect(savedAt(1).enabled).toBe(false);
    expect(savedAt(1).confirmEdit).toBe(false);
    expect(checkboxOf("settings.aiEnable").checked).toBe(false);

    await user.click(checkboxOf("settings.aiUseTools"));
    await waitFor(() => expect(api.aiSaveConfig.mock.calls.length).toBeGreaterThan(2));
    expect(savedAt(2).useTools).toBe(true);
    expect(savedAt(2).enabled).toBe(false);
    expect(savedAt(2).confirmEdit).toBe(false);
  });

  it("测试连接：先落库再测，成功后给提示", async () => {
    const user = userEvent.setup();
    api.aiTestConnection.mockResolvedValue("pong");
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.click(buttonNamed("settings.aiTest"));
    await waitFor(() => expect(api.aiTestConnection).toHaveBeenCalled());
    savedBefore(() => api.aiTestConnection.mock.invocationCallOrder[0]);
    await waitFor(() => expect(api.toastSuccess).toHaveBeenCalledWith("settings.aiTestOk"));
    expect(api.toastError).not.toHaveBeenCalled();
  });

  it("测试连接失败：报错进 toast，按钮回到可点", async () => {
    const user = userEvent.setup();
    api.aiTestConnection.mockRejectedValue(new Error("boom"));
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.click(buttonNamed("settings.aiTest"));
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith("settings.aiTestFailed"));
    await waitFor(() => expect(buttonNamed("settings.aiTest").disabled).toBe(false));
  });

  it("拉取模型：先落库再列，回来后模型从手填改成下拉并保住当前值", async () => {
    const user = userEvent.setup();
    api.aiListModels.mockResolvedValue(["gpt-a", "gpt-b"]);
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.click(buttonNamed("settings.aiFetchModels"));
    await waitFor(() => expect(api.aiListModels).toHaveBeenCalled());
    savedBefore(() => api.aiListModels.mock.invocationCallOrder[0]);

    const model = selectInRow("settings.aiModel");
    expect([...model.options].map((o) => o.value)).toEqual(["m", "gpt-a", "gpt-b"]);
    expect(model.value).toBe("m");

    await user.selectOptions(model, "gpt-b");
    await waitFor(() => expect(api.aiSaveConfig.mock.calls.length).toBeGreaterThan(1));
    expect(savedAt(1).model).toBe("gpt-b");
  });

  it("拉取模型失败：留在手填输入框，不让界面卡在空下拉", async () => {
    const user = userEvent.setup();
    api.aiListModels.mockRejectedValue(new Error("offline"));
    render(<SettingsAi />);
    await waitFor(() => expect(inputInRow("settings.aiFirstByteTimeout").value).toBe("30"));

    await user.click(buttonNamed("settings.aiFetchModels"));
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith("settings.aiFetchModelsFailed"));
    expect(inputInRow("settings.aiModel").value).toBe("m");
    expect(buttonNamed("settings.aiFetchModels").disabled).toBe(false);
  });
});
