// AI 助手 invoke 封装：配置读写 / 连接测试 / 流式对话 / 取消。
// 契约由 Rust 侧固定，JS 参数一律 camelCase（Tauri 2 自动映射到 Rust snake_case）；
// 配置读取返回值字段名为 Rust serde 结构体字段（snake_case）。

// 目录里按职责分七个小文件，index.ts 只做对外 re-export（对外符号面与拆分前一致）：
// types（对话契约）/ profile（档位与预设）/ config（配置读写）/ image（图片附件）/
// session（会话 CRUD）/ usage（用量成本）/ request（流式、取消、片段检索）。

export { aiProfileKeyInput, AI_PROVIDER_PRESETS, AI_PROTOCOL_OPTIONS } from "./profile";
export { aiGetConfig, aiListModels, aiSaveConfig, aiTestConnection } from "./config";
export { saveAiImageFile, AI_IMAGE_MIME_BY_EXT, MAX_AI_IMAGES, MAX_AI_IMAGE_BYTES } from "./image";
export { aiSessionDelete, aiSessionList, aiSessionSave } from "./session";
export { aiUsageSummary, estimateAiCost, formatAiCost, AI_PRICE_PER_MILLION } from "./usage";
export { aiCancel, aiChat, aiErrorText, docSearchSnippets } from "./request";
export type { AiChatEvent, AiChatMessage, AiToolCallRaw, AiToolCallRef, AiToolSpec, AiUsage } from "./types";
export type { AiProfile, AiProfilePublic, AiProviderPreset } from "./profile";
export type { AiConfig, AiQuickActionDef } from "./config";
export type { AiImageAttachment } from "./image";
export type { AiSessionRow } from "./session";
export type { AiUsageSummary } from "./usage";
