// AI 助手动作协议：定义与解析。
//
// 模型（任意 OpenAI 兼容服务商）通过带标记的代码块回传「动作指令」，
// 前端解析后落地（改文档 / 建页面 / 查数据库等）。之所以不只依赖 tool_calls：
// 内置的 Ollama 等本地服务商对函数调用支持参差不齐，而「文本里带约定代码块」所有服务商都支持。
// 两条路最终收敛为同一种形态（AiCall），落地逻辑不必分叉。
//
// 目录里按职责分四个小文件，index.ts 只做对外 re-export（对外 24 个符号与拆分前一致）：
// types（动作契约与块标记）/ protocol（system prompt 组装）/ validate（动作校验）/ extract（从回复里取块）。

export { AI_EDIT_OPS, CALL_BLOCK_TAG, EDIT_BLOCK_TAG, RETRIEVAL_TOOLS, WRITE_TOOLS } from "./types";
export type { AiCall, AiEditAnchor, AiEditOp, AiWriteCall, RetrievalCall, RetrievalKind, WriteTool } from "./types";
export {
  buildEditSystemPrompt,
  buildNoContextSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  CTX_SCOPE_PAGE_ONLY_NOTE,
  RETRIEVAL_BLOCKED_BY_SCOPE_NOTE,
  retrievalResultMessage,
} from "./protocol";
export type { AiEditContext } from "./protocol";
export { validateCall } from "./validate";
export { extractCalls, extractEdit, hideEditBlock, type ExtractCallsResult } from "./extract";
