import { t, type MessageKey } from "@/lib/i18n";
import { AiQuickAction } from "./types";
// 提示词素材：快捷动作的文案 key、提示词精修的 system prompt 与其解析。

export const QUICK_PROMPT_KEY: Record<AiQuickAction, MessageKey> = {
  summarize: "ai.prompt.summarize",
  translate: "ai.prompt.translate",
  rewrite: "ai.prompt.rewrite",
  explain: "ai.prompt.explain",
  continue: "ai.prompt.continue",
};

/** 「优化提问」的系统提示：只改写提问本身，不进对话、不下发编辑协议 */
export const REFINE_SYSTEM_PROMPT =
  "你是提问改写助手。用户会给你一句要发给笔记应用 AI 助手的提问，请把它改写成 3 个更清晰、更具体的版本。" +
  "每行一条，不要编号、不要引号、不要解释，保持原意，不要回答这个问题本身。";

/** 解析模型给出的改写候选：去掉编号与项目符号，最多 3 条互不重复 */
export function parsePromptIdeas(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .replace(/^\s*(?:[-*·•]|\d+[.、)])\s+/, "")
      .trim()
      .replace(/^["「『'`]+|["」』'`]+$/g, "")
      .trim();
    if (!line || line.length > 300 || out.includes(line)) continue;
    out.push(line);
    if (out.length === 3) break;
  }
  return out;
}

/** 从回答正文取页面标题：第一条非空行去掉 Markdown 记号，最多 40 字 */
export function pageTitleFrom(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.replace(/^[#>\-*+\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return t("ai.fallbackTitle");
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
