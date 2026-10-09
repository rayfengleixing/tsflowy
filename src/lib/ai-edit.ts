// AI 自主修改文档：协议定义与解析。
//
// 模型（任意 OpenAI 兼容服务商）通过一个带标记的代码块回传「编辑指令」，
// 前端解析后直接写入编辑器。之所以不用 OpenAI 的 tool_calls：内置的 Ollama 等
// 本地服务商对函数调用支持参差不齐，而「文本里带一个约定代码块」所有服务商都支持。

/**
 * 编辑指令的作用范围。
 * 刻意不含「整篇重写」：文档首行 H1 是标题、第二行分割线由 DocumentStructureLock
 * 保护，整篇替换的事务必然被拦截（见 features/editor/extensions/document-structure-lock.ts）。
 */
export type AiEditOp = "replace_selection" | "insert_at_cursor" | "append_to_document";

export const AI_EDIT_OPS: readonly AiEditOp[] = ["replace_selection", "insert_at_cursor", "append_to_document"];

/** 模型回传的编辑指令 */
export interface AiEdit {
  op: AiEditOp;
  /** Markdown 格式的新内容 */
  content: string;
  /** 一句话说明改动；模型没给时为空串，由界面兜底文案 */
  summary: string;
}

/** 编辑指令代码块的标记语言名 */
export const EDIT_BLOCK_TAG = "tsflowy-edit";

const FENCE = "```";

/** 文档上下文：随 system prompt 一并下发，让模型知道「改哪里」 */
export interface AiEditContext {
  title: string;
  /** 当前选中的文本；为空表示没有选区 */
  selection: string;
  /** 当前文档纯文本（调用方按 max_chars 截断过） */
  pageText: string;
}

const PROTOCOL = `你是 TsFlowy 笔记应用内置的写作助手，可以直接修改用户正在编辑的文档。

【编辑协议】
当用户要求你修改、重写、润色、续写、翻译、补充文档内容时，除了正常作答，
还必须在回复最后输出一个编辑指令代码块，格式严格如下：

\`\`\`${EDIT_BLOCK_TAG}
{"op":"replace_selection","summary":"一句话说明这次改了什么","content":"修改后的 Markdown 内容"}
\`\`\`

op 只能取以下三个值之一：
- replace_selection：替换用户当前选中的文字（用户没有选中时退化为在光标处插入）。最常用。
- insert_at_cursor：在光标处插入
- append_to_document：追加到文档末尾

注意：文档第一行是标题（不能改动），第二行是分割线；不要试图改动这两行。
content 用 Markdown 语法书写；summary 是一句话中文说明，会展示给用户。
每次回复最多输出一个该代码块，且必须放在整条回复的最后，代码块之后不要再写任何内容。
不要在正文中举例或解释这个标记，也不要输出第二个该代码块。
如果用户只是在提问、不需要改动文档，就不要输出这个代码块。
始终使用与用户提问相同的语言作答。`;

/** 当前没有可编辑文档时的 system prompt：只作答，不产出编辑指令 */
export const CHAT_ONLY_SYSTEM_PROMPT = `你是 TsFlowy 笔记应用内置的写作助手。当前没有打开可编辑的文档，
请直接以纯文本作答，不要输出任何编辑指令代码块。始终使用与用户提问相同的语言作答。`;

/** 组装 system prompt：编辑协议 + 当前文档上下文 */
export function buildEditSystemPrompt(ctx: AiEditContext): string {
  const target = ctx.selection
    ? `用户当前选中了以下文字，这是本次改动的默认目标（用 replace_selection）：\n<<<\n${ctx.selection}\n>>>`
    : `用户当前没有选中任何文字（改动目标按用户措辞在 insert_at_cursor 与 append_to_document 中择一）。`;
  const page = ctx.pageText.trim() || "（空文档）";
  return `${PROTOCOL}

【当前文档】标题：${ctx.title.trim() || "（未命名）"}
${target}

文档全文（仅供理解上下文，可能已被截断）：
<<<
${page}
>>>`;
}

/** 校验并规整模型给出的编辑指令；不合法返回 null */
function validateEdit(value: unknown): AiEdit | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const op = o.op;
  const content = o.content;
  if (typeof op !== "string" || !AI_EDIT_OPS.includes(op as AiEditOp)) return null;
  if (typeof content !== "string" || content.trim() === "") return null;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  return { op: op as AiEditOp, content, summary };
}

/** 提取结果：edit 为落地指令；malformed 表示「有指令块但没能解析」，界面应提示而不是展示裸 JSON */
export interface ExtractEditResult {
  edit: AiEdit | null;
  display: string;
  malformed: boolean;
}

/** 删掉文本中所有指令块（含未闭合的），只留下给用户看的正文 */
function stripEditBlocks(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf(FENCE + EDIT_BLOCK_TAG);
    if (start === -1) return out.trim();
    const bodyStart = out.indexOf("\n", start);
    if (bodyStart === -1) return out.slice(0, start).trim();
    const end = out.indexOf(FENCE, bodyStart);
    out = out.slice(0, start) + (end === -1 ? "" : out.slice(end + FENCE.length));
  }
}

/**
 * 从模型回复里提取编辑指令，并给出「去掉指令块之后」的展示文本。
 *
 * 取最后一个指令块解析：模型偶尔会在正文里先复述/举例协议，按第一个匹配会解析到错误的块。
 * 块存在但 JSON 不合法或字段不合法时置 malformed——展示裸 JSON 对用户毫无意义，
 * 但正文（所有指令块之外的部分）仍完整保留，不会静默吞掉答案。
 */
export function extractEdit(text: string): ExtractEditResult {
  const start = text.lastIndexOf(FENCE + EDIT_BLOCK_TAG);
  if (start === -1) return { edit: null, display: text, malformed: false };
  const bodyStart = text.indexOf("\n", start);
  // 只有标记、没有内容（流式被截断在标记那一行）：视为残缺指令
  if (bodyStart === -1) return { edit: null, display: stripEditBlocks(text), malformed: true };
  const end = text.indexOf(FENCE, bodyStart);
  const body = (end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end)).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { edit: null, display: stripEditBlocks(text), malformed: true };
  }
  const edit = validateEdit(parsed);
  if (!edit) return { edit: null, display: stripEditBlocks(text), malformed: true };
  return { edit, display: stripEditBlocks(text), malformed: false };
}

/**
 * 流式展示用：把还没写完的编辑指令块藏起来。
 * 指令是一段 JSON，逐字流式显示又长又难看，而且它并不是给用户看的答案。
 */
export function hideEditBlock(text: string): string {
  const start = text.lastIndexOf(FENCE + EDIT_BLOCK_TAG);
  return start === -1 ? text : text.slice(0, start);
}
