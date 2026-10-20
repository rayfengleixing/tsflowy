// @vitest-environment jsdom
// AI 设置面板的网络调优区：这批数值是本地模型/自建网关慢时的唯一自救口子，
// 界面把字段接错（或改完没落库）在纯逻辑测试里看不出来，只能真的渲染一遍点一次。
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
  AI_PROTOCOL_OPTIONS: [],
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

/** aiSaveConfig 是 mock 出来的，调用参数没有类型；断言前收成一条明确的记录 */
function savedInput(): Record<string, unknown> {
  return api.aiSaveConfig.mock.calls[0][0] as Record<string, unknown>;
}

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
