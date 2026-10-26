// 模型档位与服务商预设：档位可覆盖地址 / 模型 / 温度，协议与 Key 留空则继承全局。
// Rust 回传的档位只有掩码，明文 Key 只在保存入参里单向流过去。

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
