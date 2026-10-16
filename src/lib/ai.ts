import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/invoke";
import { uploadImageBytes } from "@/lib/assets";

// AI 助手 invoke 封装：配置读写 / 连接测试 / 流式对话 / 取消。
// 契约由 Rust 侧固定，JS 参数一律 camelCase（Tauri 2 自动映射到 Rust snake_case）；
// 配置读取返回值字段名为 Rust serde 结构体字段（snake_case）。

/** `ai_get_config` 返回的配置（Rust 侧字段名即 JSON 键名） */
export interface AiConfig {
  enabled: boolean;
  provider: string;
  /** 接口协议族："" = 按 base_url 自动识别，或 openai / anthropic / gemini */
  protocol: string;
  base_url: string;
  model: string;
  max_chars: number;
  /** AI 自主修改文档前先弹 diff 确认 */
  confirm_edit: boolean;
  /** 采样温度 0–2 */
  temperature: number;
  /** 思考模式：auto = 不下发推理参数（默认），off = 显式关闭思考 */
  thinking: string;
  /** 上下文 token 预算（历史消息回截的估算上限） */
  ctx_token_budget: number;
  /** 上下文消息条数上限 */
  ctx_max_messages: number;
  /** 最大 token 数，0 表示不限制 */
  max_tokens: number;
  /** 用户追加的自定义系统提示 */
  system_prompt: string;
  profiles: AiProfilePublic[];
  /** 当前生效档位 id，空串表示单档配置 */
  active_profile: string;
  quick_actions: AiQuickActionDef[];
  /** 是否用 function calling 下发编辑指令（默认关闭，兼容工具支持不全的服务商） */
  use_tools: boolean;
  /** 输入 token 单价（每 100 万 token，货币单位自定），0 = 未填价 */
  price_input: number;
  /** 输出 token 单价（每 100 万 token） */
  price_output: number;
  has_api_key: boolean;
  api_key_masked: string;
  /** true = 系统凭据库不可用（或明文清不掉），Key 目前明文存于 config.json */
  api_key_plaintext?: boolean;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** assistant 携带的工具调用（agent 循环回灌时原样带回服务端） */
  tool_calls?: AiToolCallRef[];
  /** role=tool 时对应的调用 id */
  tool_call_id?: string;
  /** 图片附件：只给 assets/ 相对路径，base64 由 Rust 发请求前按 path 读出内联 */
  images?: { path: string }[];
}

/** OpenAI 协议下的一个函数调用回传 */
export interface AiToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** `ai_chat` 下发的工具定义（OpenAI tools 数组元素） */
export interface AiToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 一个模型档位：可覆盖服务商地址 / 模型 / 温度，协议与 Key 留空则继承全局 */
export interface AiProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  temperature: number;
  /** "" = 跟随全局协议 */
  protocol?: string;
  /** 保存入参专用：null = 保持该档原 Key、"" = 清空、非空 = 覆盖 */
  api_key?: string | null;
}

/** Rust 回传的档位：Key 只有掩码，绝不回传明文 */
export interface AiProfilePublic {
  id: string;
  name: string;
  base_url: string;
  model: string;
  temperature: number;
  protocol: string;
  has_api_key: boolean;
  api_key_masked: string;
  /** true = 该档 Key 明文存于 config.json（凭据库写入失败） */
  api_key_plaintext?: boolean;
}

/**
 * 档位 Key 输入框的值 → 保存入参的 api_key 字段。
 * 空串按「不修改」处理（与全局 Key 的界面口径一致）——档位 Key 是逐档保存的，
 * 编辑别的字段时不该把已存的 Key 顺带清空。
 */
export function aiProfileKeyInput(draftKey: string): string | null {
  const key = draftKey.trim();
  return key === "" ? null : key;
}

/** 用户自定义快捷指令；scope 决定用哪段文本填进提示词 */
export interface AiQuickActionDef {
  id: string;
  name: string;
  /** 提示词模板，含 {content} 占位符（scope 为 none 时不需要） */
  prompt: string;
  scope: "selection" | "page" | "none";
}

/** 单次请求的 token 用量（服务商未返回时字段为 null） */
export interface AiUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

/** `ai_chat` 流式事件：chunk 增量 / reasoning 思考增量 / done 收尾全量与用量 / error 报错 */
export type AiChatEvent =
  | { type: "chunk"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; full: string; usage?: AiUsage | null; tool_calls?: AiToolCallRaw[] }
  /** code 为错误归类码（auth / rate_limit / quota / timeout / network / server …），可能为 null */
  | { type: "error"; message: string; code?: string | null };

/** Rust 侧回传的完整函数调用（Done.tool_calls / 事件流内累积） */
export interface AiToolCallRaw {
  id: string;
  name: string;
  /** JSON 字符串形式的参数 */
  arguments: string;
}

/**
 * 服务商预设：选中后自动填充 Base URL / 模型 / 协议族（用户仍可手改）。
 * protocol 省略即 ""（自动）——OpenAI 兼容端点靠 base_url 就能认，只有原生协议需要显式指定。
 */
export interface AiProviderPreset {
  id: string;
  baseUrl: string;
  model: string;
  protocol?: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: "custom", baseUrl: "", model: "" },
  { id: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { id: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514", protocol: "anthropic" },
  {
    id: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.0-flash",
    protocol: "gemini",
  },
];

/** 接口协议族下拉；"" = 交给 base_url 自动识别 */
export const AI_PROTOCOL_OPTIONS = ["", "openai", "anthropic", "gemini"] as const;

/* ————— 视觉输入：图片附件 ————— */

/** 支持的图片扩展名 → MIME；需与 Rust 侧 image_media_type 的白名单保持一致 */
export const AI_IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 一条消息最多几张图 / 单张最多多少字节（与 Rust 内联校验一致） */
export const MAX_AI_IMAGES = 4;
export const MAX_AI_IMAGE_BYTES = 6 * 1024 * 1024;

/** 视觉模型普遍把输入缩到 1–1.5k 像素，再大的边长只是白占请求体 */
const IMAGE_MAX_EDGE = 1568;
/** 小图不重编码：省一次解码，也避免把无损截图压糊 */
const IMAGE_PASSTHROUGH_BYTES = 512 * 1024;
/** gif 重编码会丢掉动画，只缩静态图 */
const SHRINKABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 一张待发送的图片：只存 assets/ 相对路径，会话 JSON 因此保持很小 */
export interface AiImageAttachment {
  name: string;
  path: string;
}

/** 从文件名或 MIME 取受支持的扩展名；都不认时返回 null */
function aiImageExt(name: string, mime: string): string | null {
  const dot = name.lastIndexOf(".");
  const fromName = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (fromName in AI_IMAGE_MIME_BY_EXT) return fromName;
  const lower = mime.toLowerCase();
  return Object.entries(AI_IMAGE_MIME_BY_EXT).find(([, m]) => m === lower)?.[0] ?? null;
}

/**
 * 把大图缩到视觉模型真正吃得下的分辨率。各家接口都会把输入下采样，原图越大只是请求体越胖，
 * 而带图的这条消息在 agent 多步循环里每轮都要重发一次。
 * 小图、动图（gif）和解码失败的情况一律原样返回。
 */
async function downscaleImage(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (bytes.length <= IMAGE_PASSTHROUGH_BYTES || !SHRINKABLE.has(mime)) return bytes;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close();
      return bytes;
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return bytes;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // 保持原格式重编码，扩展名与 MIME 不必跟着改
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime));
    if (!blob || blob.size >= bytes.length) return bytes;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return bytes;
  }
}

/**
 * 剪贴板 / 文件选择得到的图片 → 存进 assets/ 并返回附件引用。
 * 类型或体积不合要求就地抛错：让用户当场看到原因，比发到服务商那边才失败好，
 * 也比静默丢掉图片好（用户明确附了图）。
 */
export async function saveAiImageFile(file: File): Promise<AiImageAttachment> {
  const ext = aiImageExt(file.name, file.type);
  if (!ext) throw new Error(`不支持的图片格式：${file.name || file.type || "未命名图片"}`);
  if (file.size > MAX_AI_IMAGE_BYTES) {
    const mb = Math.round(MAX_AI_IMAGE_BYTES / 1024 / 1024);
    throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），单张上限 ${mb} MB`);
  }
  const mime = AI_IMAGE_MIME_BY_EXT[ext];
  const raw = new Uint8Array(await file.arrayBuffer());
  const path = await uploadImageBytes(await downscaleImage(raw, mime), ext);
  return { name: file.name.trim() || `图片.${ext}`, path };
}

/** 统一把任意异常转成可展示的字符串（invoke 失败时通常抛出 string） */
export function aiErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function aiGetConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

/** apiKey：null = 不修改，"" = 清空（Rust 侧语义）；空串与 null 由调用方区分 */
export async function aiSaveConfig(input: {
  enabled: boolean;
  provider: string;
  protocol: string;
  baseUrl: string;
  model: string;
  maxChars: number;
  confirmEdit: boolean;
  temperature: number;
  /** "auto" | "off" */
  thinking: string;
  ctxTokenBudget: number;
  ctxMaxMessages: number;
  maxTokens: number;
  systemPrompt: string;
  profiles: AiProfile[];
  activeProfile: string;
  quickActions: AiQuickActionDef[];
  useTools: boolean;
  /** token 单价（每 100 万 token），0 = 未填价、不做费用估算 */
  priceInput: number;
  priceOutput: number;
  apiKey: string | null;
}): Promise<void> {
  // 顶层参数名走 Tauri 的 camelCase 映射，但结构体内部字段由 serde 按 Rust 原名反序列化，
  // 因此这里必须显式转回 snake_case，否则会报 missing field `base_url`
  await invoke("ai_save_config", {
    cfg: {
      enabled: input.enabled,
      provider: input.provider,
      protocol: input.protocol,
      base_url: input.baseUrl,
      model: input.model,
      max_chars: input.maxChars,
      confirm_edit: input.confirmEdit,
      temperature: input.temperature,
      thinking: input.thinking,
      ctx_token_budget: input.ctxTokenBudget,
      ctx_max_messages: input.ctxMaxMessages,
      max_tokens: input.maxTokens,
      system_prompt: input.systemPrompt,
      profiles: input.profiles,
      active_profile: input.activeProfile,
      quick_actions: input.quickActions,
      use_tools: input.useTools,
      price_input: input.priceInput,
      price_output: input.priceOutput,
      api_key: input.apiKey,
    },
  });
}

export async function aiTestConnection(): Promise<string> {
  return invoke<string>("ai_test_connection");
}

/** 拉取当前 Base URL 下的可用模型列表；服务商不提供该接口时会抛错 */
export async function aiListModels(): Promise<string[]> {
  return invoke<string[]>("ai_list_models");
}

/** 库中的 AI 会话行；messages 是整条会话消息数组的 JSON 字符串 */
export interface AiSessionRow {
  id: string;
  title: string;
  page_id: string | null;
  page_title: string | null;
  updated_at: string;
  messages: string;
  /** 会话累计输入 token（017 列） */
  prompt_tokens: number;
  /** 会话累计输出 token */
  completion_tokens: number;
  /** 归档位：归档的会话不进日常历史列表，仍可检索与还原 */
  archived: boolean;
}

/** 读取库中的 AI 会话（按 updated_at 降序） */
export async function aiSessionList(): Promise<AiSessionRow[]> {
  return invoke<AiSessionRow[]>("ai_session_list");
}

/** 保存单个会话（存在则整行覆盖） */
export async function aiSessionSave(session: AiSessionRow): Promise<void> {
  await invoke("ai_session_save", { session });
}

/** 删除单个会话（幂等） */
export async function aiSessionDelete(id: string): Promise<void> {
  await invoke("ai_session_delete", { id });
}

/** 全部会话的 token 累计（由 Rust 侧 SUM，避免把每行 messages 读回前端） */
export interface AiUsageSummary {
  sessions: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export async function aiUsageSummary(): Promise<AiUsageSummary> {
  return invoke<AiUsageSummary>("ai_usage_summary");
}

/** 单价按「每 100 万 token」计，与各家计费页口径一致 */
export const AI_PRICE_PER_MILLION = 1_000_000;

/**
 * 费用估算：单价未填（两者皆 0）时返回 null，界面就不显示金额——
 * 显示 ¥0.00 会被读成「免费」，而真实原因只是用户还没填价。
 */
export function estimateAiCost(
  usage: { prompt: number; completion: number },
  priceInput: number,
  priceOutput: number,
): number | null {
  if (priceInput <= 0 && priceOutput <= 0) return null;
  return (usage.prompt * priceInput + usage.completion * priceOutput) / AI_PRICE_PER_MILLION;
}

/** 金额文案：小额留 3 位小数（0.0007 显示成 0.00 等于没说），大额 2 位 */
export function formatAiCost(amount: number): string {
  return amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
}

/** 流式对话：用 Channel 接收事件，逐段回调给上层。tools 为 agent 工具定义（前端编排多步循环） */
export async function aiChat(
  messages: AiChatMessage[],
  onEvent: (ev: AiChatEvent) => void,
  tools?: AiToolSpec[],
): Promise<void> {
  const channel = new Channel<AiChatEvent>();
  channel.onmessage = onEvent;
  // Rust 侧签名为 ai_chat(req, on_event)：参数名要一一对应（req / onEvent）
  await invoke("ai_chat", { req: { messages, tools: tools ?? null }, onEvent: channel });
}

export async function aiCancel(): Promise<void> {
  await invoke("ai_cancel");
}

/**
 * 单篇文档内检索与问题相关的片段（AI @ 引用的上下文用）。
 * 命中为空（查询太短 / 该文档还没进索引）时返回空数组，调用方回退到整篇截断。
 */
export async function docSearchSnippets(viewId: string, query: string, limit = 8): Promise<string[]> {
  return invoke<string[]>("doc_search_snippets", { viewId, query, limit });
}
