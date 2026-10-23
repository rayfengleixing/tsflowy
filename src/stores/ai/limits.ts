// 面板宽度与各类兜底上限、localStorage 键名，以及宽度偏好的读取。

export const PANEL_WIDTH_KEY = "tsflowy-ai-panel-width";
export const DEFAULT_WIDTH = 360;
export const MIN_WIDTH = 280;
export const MAX_WIDTH = 640;
export const DEFAULT_MAX_CHARS = 8000;
/**
 * 一次提问内允许的最大模型往返次数：每轮模型可以要求若干次只读检索，
 * 前端执行后把结果喂回模型继续。上限用来兜住「模型反复要求检索却收敛不了」的情况。
 * 实际值取设置里的 agent_rounds（弱模型常在第 4 轮前收敛不了，写死只能少查或一直转圈），这只是兜底。
 */
export const DEFAULT_AGENT_ROUNDS = 4;

export const AI_WIDTH_LIMITS = { min: MIN_WIDTH, max: MAX_WIDTH };

export const SESSIONS_KEY = "tsflowy-ai-sessions-v1";
/** localStorage 兜底容量；同时作为历史面板的默认显示窗口 / 「加载更多」步长（库中的会话不计数截断、不删除） */
export const MAX_SESSIONS = 20;
export const MAX_SESSION_MESSAGES = 200;
export const MAX_MESSAGE_CHARS = 100_000;
// 长对话防超限：历史消息按估算 token 从最新往前收进预算，放不下的早期轮次直接丢弃
// （system prompt 与 @ 引用上下文不占预算，不受影响）。
// 按 token 而非字符计：中文 1 字 ≈ 1 token、拉丁 4 字符 ≈ 1 token，字符预算对两种文本失真严重。
// 两项可在设置里配置（config.ctx_token_budget / ctx_max_messages），这里只是兜底默认值。
export const DEFAULT_HISTORY_TOKEN_BUDGET = 3000;
export const DEFAULT_HISTORY_MAX_MESSAGES = 40;
export function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
