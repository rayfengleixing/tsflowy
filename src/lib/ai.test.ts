import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.hoisted(() => vi.fn((_bytes: Uint8Array, _ext: string) => Promise.resolve("assets/1712345.png")));
const invokeMock = vi.hoisted(() => vi.fn((_cmd: string, _args?: unknown) => Promise.resolve(undefined)));

vi.mock("@/lib/assets", () => ({ uploadImageBytes: uploadMock }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke: invokeMock }));

import { MAX_AI_IMAGE_BYTES, aiSaveConfig, estimateAiCost, formatAiCost, saveAiImageFile } from "./ai";

/** File 在 jsdom 里缺 arrayBuffer()；这里只需要 name/type/size 三个属性参与判断 */
function imageLike(init: { name?: string; type?: string; size?: number; payload?: number }): File {
  return {
    name: init.name ?? "",
    type: init.type ?? "",
    size: init.size ?? 2048,
    arrayBuffer: () => Promise.resolve(new Uint8Array(init.payload ?? 3).buffer),
  } as unknown as File;
}

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
      maxTokens: 0,
      systemPrompt: "",
      profiles: [],
      activeProfile: "",
      quickActions: [],
      useTools: false,
      priceInput: 2,
      priceOutput: 8,
      apiKey: null,
    });
    const cfg = (invokeMock.mock.calls[0][1] as { cfg: Record<string, unknown> }).cfg;
    expect(cfg.protocol).toBe("anthropic");
    expect(cfg.price_input).toBe(2);
    expect(cfg.price_output).toBe(8);
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
});
