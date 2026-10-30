// @vitest-environment jsdom
// 默认跑在 node 里，imageLike / Blob 够用；但「大图真的缩放」那组要碰 document.createElement("canvas")
// 与 HTMLCanvasElement.prototype，得把整个文件放进 jsdom（node 下那条兜底用例照样绿）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.hoisted(() => vi.fn((_bytes: Uint8Array, _ext: string) => Promise.resolve("assets/1712345.png")));
const invokeMock = vi.hoisted(() => vi.fn((_cmd: string, _args?: unknown) => Promise.resolve(undefined)));
// Channel 替身要能事后往里投事件：aiChat 把上层的 onEvent 挂到实例的 onmessage 上，
// 记不住实例就没法验「服务端帧到底走到哪」
interface FakeChannel {
  onmessage?: (ev: unknown) => void;
}
const channels = vi.hoisted(() => [] as FakeChannel[]);

vi.mock("@/lib/assets/assets", () => ({ uploadImageBytes: uploadMock }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (ev: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
  invoke: invokeMock,
}));

import * as aiModule from "./index";
import {
  MAX_AI_IMAGE_BYTES,
  aiCancel,
  aiChat,
  aiErrorText,
  aiGetConfig,
  aiListModels,
  aiProfileKeyInput,
  aiSaveConfig,
  aiSessionDelete,
  aiSessionList,
  aiSessionSave,
  aiTestConnection,
  aiUsageSummary,
  docSearchSnippets,
  estimateAiCost,
  formatAiCost,
  saveAiImageFile,
  type AiChatEvent,
  type AiSessionRow,
  type AiToolSpec,
} from "./index";

/** 调完取最后一次 invoke 记录（tsconfig 的 lib 里没有 Array.prototype.at） */
function lastCall(): [string, unknown] {
  const call = invokeMock.mock.calls[invokeMock.mock.calls.length - 1];
  return [call[0], call[1]];
}

function lastChannel(): FakeChannel {
  return channels[channels.length - 1];
}

/** File 在 jsdom 里缺 arrayBuffer()；这里只需要 name/type/size 三个属性参与判断 */
function imageLike(init: { name?: string; type?: string; size?: number; payload?: number }): File {
  return {
    name: init.name ?? "",
    type: init.type ?? "",
    size: init.size ?? 2048,
    arrayBuffer: () => Promise.resolve(new Uint8Array(init.payload ?? 3).buffer),
  } as unknown as File;
}

describe("@/lib/ai 的对外符号面", () => {
  // 拆成目录模块后 index.ts 手写 12 行 re-export：漏一行且当下没人用那个符号，tsc 也不会报
  const VALUE_EXPORTS = [
    "aiProfileKeyInput",
    "AI_PROVIDER_PRESETS",
    "AI_PROTOCOL_OPTIONS",
    "aiGetConfig",
    "aiListModels",
    "aiSaveConfig",
    "aiTestConnection",
    "saveAiImageFile",
    "AI_IMAGE_MIME_BY_EXT",
    "MAX_AI_IMAGES",
    "MAX_AI_IMAGE_BYTES",
    "aiSessionList",
    "aiSessionSave",
    "aiSessionDelete",
    "aiUsageSummary",
    "estimateAiCost",
    "formatAiCost",
    "AI_PRICE_PER_MILLION",
    "aiChat",
    "aiCancel",
    "aiErrorText",
    "docSearchSnippets",
  ];

  it("运行时的 22 个值导出一个不少（类型导出由 tsc 在消费点验）", () => {
    expect(Object.keys(aiModule).sort()).toEqual([...VALUE_EXPORTS].sort());
  });
});

describe("saveAiImageFile", () => {
  beforeEach(() => {
    uploadMock.mockClear();
  });

  it("按文件名扩展名入库，返回会话里存的名字与相对路径", async () => {
    const saved = await saveAiImageFile(imageLike({ name: "截图.PNG", type: "" }));
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(uploadMock.mock.calls[0][1]).toBe("png");
    expect(saved).toEqual({ name: "截图.PNG", path: "assets/1712345.png" });
  });

  it("剪贴板图片没有文件名时按 MIME 兜底", async () => {
    const saved = await saveAiImageFile(imageLike({ name: "", type: "image/webp" }));
    expect(uploadMock.mock.calls[0][1]).toBe("webp");
    expect(saved.name).toBe("图片.webp");
  });

  it("白名单外的格式直接拒绝，不会占用 assets 目录", async () => {
    uploadMock.mockClear();
    await expect(saveAiImageFile(imageLike({ name: "icon.svg", type: "image/svg+xml" }))).rejects.toThrow(
      /不支持的图片格式/,
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("超过单张体积上限时拒绝，错误里给出实际大小", async () => {
    const big = imageLike({ name: "a.png", type: "image/png", size: MAX_AI_IMAGE_BYTES + 1024 });
    await expect(saveAiImageFile(big)).rejects.toThrow(/图片太大/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("MIME 与文件名都不认时拒绝", async () => {
    await expect(saveAiImageFile(imageLike({ name: "notes.txt", type: "text/plain" }))).rejects.toThrow(
      /不支持的图片格式/,
    );
  });

  it("小图不重编码，字节原样入库", async () => {
    await saveAiImageFile(imageLike({ name: "s.png", type: "image/png", size: 400_000, payload: 400_000 }));
    expect(uploadMock.mock.calls[0][0].length).toBe(400_000);
  });

  it("动图不缩放：重编码会丢掉动画，保留原始字节", async () => {
    await saveAiImageFile(imageLike({ name: "meme.gif", type: "image/gif", size: 2_000_000, payload: 2_000_000 }));
    expect(uploadMock.mock.calls[0][1]).toBe("gif");
    expect(uploadMock.mock.calls[0][0].length).toBe(2_000_000);
  });

  it("环境不支持解码时退回原始字节，而不是把附件拒了", async () => {
    // jsdom 没有 createImageBitmap / canvas，正是这条兜底路径
    await saveAiImageFile(imageLike({ name: "shot.png", type: "image/png", size: 2_000_000, payload: 2_000_000 }));
    expect(uploadMock.mock.calls[0][0].length).toBe(2_000_000);
  });
});

describe("aiSaveConfig 入参", () => {
  beforeEach(() => invokeMock.mockClear());

  it("protocol 与 token 单价都要下发：Rust 侧 AiConfigInput 缺字段会整次保存失败", async () => {
    await aiSaveConfig({
      enabled: true,
      provider: "custom",
      protocol: "anthropic",
      baseUrl: "https://x",
      model: "claude",
      maxChars: 8000,
      confirmEdit: true,
      temperature: 0.7,
      thinking: "off",
      ctxTokenBudget: 5000,
      ctxMaxMessages: 12,
      ctxScope: "page_only",
      maxTokens: 0,
      systemPrompt: "",
      profiles: [],
      activeProfile: "",
      quickActions: [],
      useTools: false,
      priceInput: 2,
      priceOutput: 8,
      agentRounds: 6,
      firstByteTimeout: 90,
      idleTimeout: 300,
      streamRetries: 4,
      apiKey: null,
    });
    const cfg = (invokeMock.mock.calls[0][1] as { cfg: Record<string, unknown> }).cfg;
    expect(cfg.protocol).toBe("anthropic");
    expect(cfg.price_input).toBe(2);
    expect(cfg.price_output).toBe(8);
    // 新字段同样要转成 snake_case 下发（serde 按 Rust 字段名反序列化）
    expect(cfg.thinking).toBe("off");
    expect(cfg.ctx_token_budget).toBe(5000);
    expect(cfg.ctx_max_messages).toBe(12);
    expect(cfg.ctx_scope).toBe("page_only");
    expect(cfg.agent_rounds).toBe(6);
    expect(cfg.first_byte_timeout).toBe(90);
    expect(cfg.idle_timeout).toBe(300);
    expect(cfg.stream_retries).toBe(4);
  });

  it("档位草稿 Key 按 aiProfileKeyInput 口径转成 api_key 字段", async () => {
    await aiSaveConfig({
      enabled: true,
      provider: "custom",
      protocol: "",
      baseUrl: "https://x",
      model: "m",
      maxChars: 8000,
      confirmEdit: true,
      temperature: 0.7,
      thinking: "auto",
      ctxTokenBudget: 3000,
      ctxMaxMessages: 40,
      ctxScope: "full",
      maxTokens: 0,
      systemPrompt: "",
      profiles: [
        {
          id: "p1",
          name: "A",
          base_url: "",
          model: "",
          temperature: 0.7,
          protocol: "",
          api_key: aiProfileKeyInput("  "),
        },
        {
          id: "p2",
          name: "B",
          base_url: "",
          model: "",
          temperature: 0.7,
          protocol: "gemini",
          api_key: aiProfileKeyInput(" new-key "),
        },
      ],
      activeProfile: "",
      quickActions: [],
      useTools: false,
      priceInput: 0,
      priceOutput: 0,
      agentRounds: 4,
      firstByteTimeout: 30,
      idleTimeout: 120,
      streamRetries: 2,
      apiKey: null,
    });
    const cfg = (invokeMock.mock.calls[0][1] as { cfg: Record<string, unknown> }).cfg;
    const profiles = cfg.profiles as Record<string, unknown>[];
    // 空草稿 → null = 保持该档原 Key；有草稿 → 去空白后覆盖
    expect(profiles[0].api_key).toBeNull();
    expect(profiles[1].api_key).toBe("new-key");
    expect(profiles[1].protocol).toBe("gemini");
  });
});

describe("aiProfileKeyInput", () => {
  it("空串与纯空白都是「不修改」；其余去首尾空白", () => {
    expect(aiProfileKeyInput("")).toBeNull();
    expect(aiProfileKeyInput("   ")).toBeNull();
    expect(aiProfileKeyInput(" sk-abc ")).toBe("sk-abc");
  });
});

describe("token 费用估算", () => {
  it("按每 100 万 token 单价折算", () => {
    expect(estimateAiCost({ prompt: 1_000_000, completion: 500_000 }, 2, 8)).toBeCloseTo(6, 10);
  });

  it("单价未填时返回 null，界面不该显示 ¥0 让人误以为免费", () => {
    expect(estimateAiCost({ prompt: 12_000, completion: 3_000 }, 0, 0)).toBeNull();
  });

  it("负单价（手滑填错）同样按未填处理", () => {
    expect(estimateAiCost({ prompt: 1, completion: 1 }, -3, 0)).toBeNull();
  });

  it("小额用量给出 4 位小数，避免 0.0007 被显示成 0.00", () => {
    expect(formatAiCost(estimateAiCost({ prompt: 350, completion: 0 }, 2, 8) ?? NaN)).toBe("0.0007");
  });

  it("大额保留 2 位小数", () => {
    expect(formatAiCost(12.3456)).toBe("12.35");
  });

  it("拆文件后单价口径仍是每 100 万 token", () => {
    // AI_PRICE_PER_MILLION 从 usage.ts 换到了 index 的另一行 re-export 上，值本身是最容易搬错的东西
    expect(aiModule.AI_PRICE_PER_MILLION).toBe(1_000_000);
  });
});

describe("aiChat 的 Channel 接线", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    channels.length = 0;
  });

  it("不传 tools 时下发 tools: null：这是与 Rust 的契约，缺字段会反序列化失败", async () => {
    const onEvent = vi.fn();
    await aiChat([{ role: "user", content: "你好" }], onEvent);
    const [cmd, args] = lastCall();
    expect(cmd).toBe("ai_chat");
    const sent = args as { req: { messages: unknown; tools: unknown }; onEvent: unknown };
    expect(sent.req.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(sent.req.tools).toBeNull();
    // Rust 侧签名的第二个参数名是 onEvent，写成 on_event 会收不到任何流式帧
    expect(sent.onEvent).toBe(lastChannel());
  });

  it("带 tools 时原样下发，服务端帧从 channel.onmessage 透传给上层回调", async () => {
    const tools: AiToolSpec[] = [
      { type: "function", function: { name: "list_pages", description: "列页面", parameters: {} } },
    ];
    const seen: AiChatEvent[] = [];
    await aiChat([], (ev) => seen.push(ev), tools);
    const sent = lastCall()[1] as { req: { tools: unknown } };
    expect(sent.req.tools).toEqual(tools);
    const channel = lastChannel();
    channel.onmessage?.({ type: "chunk", delta: "片段" });
    expect(seen).toEqual([{ type: "chunk", delta: "片段" }]);
  });
});

describe("会话与片段检索的命令名与参数名", () => {
  const row: AiSessionRow = {
    id: "s1",
    title: "会话",
    page_id: null,
    page_title: null,
    updated_at: "2026-10-26T00:00:00",
    messages: "[]",
    prompt_tokens: 0,
    completion_tokens: 0,
    archived: false,
  };

  beforeEach(() => invokeMock.mockClear());

  it("保存走 { session }、删除走 { id }：与 Rust 命令签名对不上就整条失败", async () => {
    await aiSessionSave(row);
    expect(lastCall()).toEqual(["ai_session_save", { session: row }]);
    await aiSessionDelete("s1");
    expect(lastCall()).toEqual(["ai_session_delete", { id: "s1" }]);
  });

  it("片段检索用 camelCase 的 viewId，limit 默认 8", async () => {
    await docSearchSnippets("v1", "季度复盘");
    expect(lastCall()).toEqual(["doc_search_snippets", { viewId: "v1", query: "季度复盘", limit: 8 }]);
    await docSearchSnippets("v1", "季度复盘", 2);
    expect(lastCall()).toEqual(["doc_search_snippets", { viewId: "v1", query: "季度复盘", limit: 2 }]);
  });

  it("剩下几条单行转调壳逐条打对自己的命令名：搬进别的文件时最容易顺手改错", async () => {
    await aiGetConfig();
    expect(lastCall()[0]).toBe("ai_get_config");
    await aiTestConnection();
    expect(lastCall()[0]).toBe("ai_test_connection");
    await aiListModels();
    expect(lastCall()[0]).toBe("ai_list_models");
    await aiSessionList();
    expect(lastCall()[0]).toBe("ai_session_list");
    await aiUsageSummary();
    expect(lastCall()[0]).toBe("ai_usage_summary");
    await aiCancel();
    expect(lastCall()[0]).toBe("ai_cancel");
  });
});

describe("aiErrorText", () => {
  it("字符串原样、Error 取 message、其余走 String()", () => {
    expect(aiErrorText("服务商返回 401")).toBe("服务商返回 401");
    expect(aiErrorText(new Error("超时"))).toBe("超时");
    expect(aiErrorText(null)).toBe("null");
  });
});

// jsdom 没有 createImageBitmap 与 canvas 2d，所以「小图直通 / 动图不缩 / 解码失败退回原字节」
// 三条兜底一跑就过，真正的缩放主路径从来没被走过。这里替出解码与重编码的最小形状，把两条
// 只在真浏览器里成立的分支钉住：缩完的宽高、以及「重编码反而更大就不换」。
describe("大图真的缩放并重编码", () => {
  const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const drawImage = vi.fn();
  let saved: [string, PropertyDescriptor | undefined][] = [];

  const putProto = (key: string, value: unknown) => {
    canvasProto[key] = value;
  };

  beforeEach(() => {
    saved = ["getContext", "toBlob"].map((key) => [key, Object.getOwnPropertyDescriptor(canvasProto, key)]);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve({ width: 3000, height: 2000, close: vi.fn() })),
    );
    putProto("getContext", () => ({ drawImage }));
    putProto("toBlob", (cb: (blob: Blob | null) => void, mime?: string) => {
      cb(new Blob([new Uint8Array(10)], { type: mime ?? "" }));
    });
    uploadMock.mockClear();
    drawImage.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(canvasProto, key, desc);
      else Object.defineProperty(canvasProto, key, { value: undefined, configurable: true, writable: true });
    }
  });

  it("长边夹到 1568、按原格式重编码，入库的是重编码后的字节", async () => {
    await saveAiImageFile(imageLike({ name: "shot.png", type: "image/png", size: 2_000_000, payload: 2_000_000 }));
    expect(drawImage).toHaveBeenCalledOnce();
    // 3000×2000 → 1568×1045（等比，长边正好落在上限）
    expect(drawImage.mock.calls[0]).toEqual([expect.anything(), 0, 0, 1568, 1045]);
    expect(uploadMock.mock.calls[0][0].length).toBe(10);
    expect(uploadMock.mock.calls[0][1]).toBe("png");
  });

  it("重编码后反而更大时保留原始字节：省体积是这件事的唯一理由", async () => {
    putProto("toBlob", (cb: (blob: Blob | null) => void) => {
      cb(new Blob([new Uint8Array(5_000_000)], { type: "image/png" }));
    });
    await saveAiImageFile(imageLike({ name: "shot.png", type: "image/png", size: 2_000_000, payload: 2_000_000 }));
    expect(uploadMock.mock.calls[0][0].length).toBe(2_000_000);
  });
});
