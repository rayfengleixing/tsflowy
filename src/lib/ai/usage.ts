// 用量与成本：累计 token 由 Rust 侧 SUM 出来，单价换算与金额文案在前端。

import { invoke } from "@/lib/invoke";

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
