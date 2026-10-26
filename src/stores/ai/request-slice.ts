import { docSearchSnippets, type AiChatMessage } from "@/lib/ai";
import {
  buildEditSystemPrompt,
  buildNoContextSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  CTX_SCOPE_PAGE_ONLY_NOTE,
} from "@/lib/ai-edit";
import { getAiEditor } from "@/lib/ai-editor";
import { parseMentions } from "@/lib/ai-mention";
import { estimateTokens, tailTokens } from "./tokens";
import { documentApi } from "@/lib/documents";
import { logger } from "@/lib/logger";
import { jsonToMarkdown } from "@/lib/markdown";
import { flattenTree } from "@/lib/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { parseViewAliases } from "@/types/models";
import {
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TOKEN_BUDGET,
  DEFAULT_MAX_CHARS,
} from "./limits";
import { type JSONContent } from "@tiptap/core";
import type { AiGet } from "./types";

/** 出请求切片对外的动作面：`systemMessage` 只被 `requestMessages` 用，留在切片内部 */
export interface AiRequestActions {
  maxChars: () => number;
  agentRounds: () => number;
  halvedContextBudget: () => number | null;
  ctxScope: () => "full" | "page_only" | "off";
  requestMessages: (assistantId: string, referenceContext?: string, budgetOverride?: number) => AiChatMessage[];
  buildReferenceContext: () => Promise<string>;
}

// 出请求那一侧的派生：配置读数（上下文字符数 / 往返轮数 / 上下文范围 / 降预算补发）与要发给服务端的消息组装。
// 全部只读 get()，没有写动作，所以注入的是 get 而不是 set / get 两个。
export const createRequestSlice = (get: AiGet): AiRequestActions => {
  /** 当前配置的最大上下文字符数 */
  const maxChars = () => {
    const configured = get().config?.max_chars;
    return configured && configured > 0 ? configured : DEFAULT_MAX_CHARS;
  };

  /** 一次提问允许的模型往返轮数（配置项 agent_rounds），兜底 4 轮 */
  const agentRounds = () => {
    const configured = get().config?.agent_rounds;
    return configured && configured > 0 ? configured : DEFAULT_AGENT_ROUNDS;
  };

  /**
   * 撞上下文上限后补发用的历史预算：砍一半。低于 500 token 就不值得再试——
   * 截到那种长度的对话根本接不上，不如直接把报错交给用户。
   */
  const halvedContextBudget = (): number | null => {
    const cfg = get().config;
    const current =
      cfg?.ctx_token_budget && cfg.ctx_token_budget > 0 ? cfg.ctx_token_budget : DEFAULT_HISTORY_TOKEN_BUDGET;
    const next = Math.floor(current / 2);
    return next < 500 ? null : next;
  };

  /**
   * 上下文范围（配置项 ctx_scope）：只认 page_only / off，其余按 full。
   * 没有可编辑文档时 page_only 与 full 等价——「本页」根本不存在，
   * 此时关掉检索只会让模型一个字都拿不到。
   */
  const ctxScope = (): "full" | "page_only" | "off" => {
    const s = get().config?.ctx_scope;
    if (s === "off") return "off";
    if (s === "page_only" && getAiEditor()) return "page_only";
    return "full";
  };

  /**
   * system prompt：有可编辑文档时下发编辑协议 + 当前文档上下文（AI 自主修改的基础），
   * 没有文档时退化为纯问答，避免模型凭空产出编辑指令。
   * off 档只给协议、不给文档内容；page_only 档在协议后追加「别发检索请求」的范围说明。
   */
  const systemMessage = (): AiChatMessage => {
    const bridge = getAiEditor();
    const scope = ctxScope();
    if (!bridge) return { role: "system", content: CHAT_ONLY_SYSTEM_PROMPT };
    if (scope === "off") return { role: "system", content: buildNoContextSystemPrompt(true) };
    const limit = maxChars();
    const prompt = buildEditSystemPrompt({
      title: bridge.getPageTitle(),
      selection: bridge.getSelectionText().slice(0, limit),
      pageText: bridge.getPageText().slice(0, limit),
    });
    return {
      role: "system",
      content: scope === "page_only" ? `${prompt}\n\n${CTX_SCOPE_PAGE_ONLY_NOTE}` : prompt,
    };
  };

  /** 组装发给服务端的消息：system + 参考文档 + 历史对话（排除空的助手占位） */
  const requestMessages = (assistantId: string, referenceContext = "", budgetOverride?: number): AiChatMessage[] => {
    const history = get()
      .messages.filter((m) => m.id !== assistantId && (m.content.trim().length > 0 || m.images?.length))
      .map((m) => ({
        role: m.role,
        content: m.content,
        // 只给路径：图片字节由 Rust 在发请求前按 assets 相对路径读出内联
        ...(m.images?.length ? { images: m.images.map((i) => ({ path: i.path })) } : {}),
      }));
    // 长对话防超限：按估算 token 从最新往前收进预算，放不下的早期轮次丢弃。
    // 预算与条数上限可在设置里配置，非法/缺省值回落默认；budgetOverride 用于撞上限后的降预算补发。
    const cfg = get().config;
    const tokenBudget =
      budgetOverride && budgetOverride > 0
        ? budgetOverride
        : cfg?.ctx_token_budget && cfg.ctx_token_budget > 0
          ? cfg.ctx_token_budget
          : DEFAULT_HISTORY_TOKEN_BUDGET;
    const maxHistory =
      cfg?.ctx_max_messages && cfg.ctx_max_messages > 0 ? cfg.ctx_max_messages : DEFAULT_HISTORY_MAX_MESSAGES;
    const kept: AiChatMessage[] = [];
    let budget = tokenBudget;
    for (let i = history.length - 1; i >= 0 && kept.length < maxHistory; i--) {
      const m = history[i];
      const cost = estimateTokens(m.content);
      if (cost > budget) {
        // 一条都放不下（如首轮就粘贴长文）：保最新一条的尾部
        if (kept.length === 0) kept.push({ role: m.role, content: tailTokens(m.content, tokenBudget) });
        break;
      }
      budget -= cost;
      kept.unshift(m);
    }
    const dropped = history.length - kept.length;
    // 编辑器带入的选中内容：单独一条 system 下发，不塞进用户消息正文（气泡里不必重复一大段原文）
    const pending = get().pendingContext?.trim();
    return [
      systemMessage(),
      ...(referenceContext ? [{ role: "system" as const, content: referenceContext }] : []),
      ...(pending ? [{ role: "system" as const, content: `【用户在文档中选中的内容】\n${pending}` }] : []),
      // 发生截断时显式告知模型，免得它把「从这里开始」误当成整段对话的开头
      ...(dropped > 0
        ? [
            {
              role: "system" as const,
              content: `【注意】受上下文预算限制，本对话最早的 ${dropped} 条消息已被截断、未随本次请求发送；需要更早的信息时请让用户补充。`,
            },
          ]
        : []),
      ...kept,
    ];
  };

  /**
   * 用户消息里 `@文件名` 引用的文档 → 参考上下文。
   * 短文档整篇给出；长文档先按问题检索相关片段，检索不到才回退整篇截断并写明截断了多少，
   * 避免模型拿着被静默砍掉的上下文作答。
   * 引用名解析不到（改名/删除/未同步）时静默跳过，不影响本轮提问。
   */
  const buildReferenceContext = async (): Promise<string> => {
    const lastUser = [...get().messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return "";
    const list = flattenTree(useWorkspaceStore.getState().tree);
    if (list.length === 0) return "";
    const refs = parseMentions(
      lastUser.content,
      // 每个叫法各给一条候选（标题 + 别名）：@ 的是别名时也要认出这一篇；同一 id 命中多次只保留一次
      list.flatMap((v) => [v.name, ...parseViewAliases(v.aliases)].map((name) => ({ id: v.id, name }))),
    );
    if (refs.length === 0) return "";
    const limit = maxChars();
    // 检索词取用户问题的正文（去掉 @ 提及的文档名，它们不是查询意图）
    const query = lastUser.content.replace(/@\S+/g, " ").trim() || lastUser.content;
    const parts: string[] = [];
    for (const ref of refs) {
      try {
        const raw = await documentApi.get(ref.id);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as JSONContent | JSONContent[];
        const doc: JSONContent = Array.isArray(parsed) ? { type: "doc", content: parsed } : parsed;
        const md = jsonToMarkdown(doc).trim();
        if (!md) continue;
        if (md.length <= limit) {
          parts.push(`### ${ref.name}\n${md}`);
          continue;
        }
        // 超长：优先按问题取相关片段
        const snippets = await docSearchSnippets(ref.id, query, 8).catch(() => [] as string[]);
        if (snippets.length > 0) {
          const body = snippets.join("\n…\n").slice(0, limit);
          parts.push(`### ${ref.name}（长文档，已按问题检索出 ${snippets.length} 个相关片段）\n${body}`);
        } else {
          const cut = md.length - limit;
          parts.push(
            `### ${ref.name}（长文档，未命中相关片段，仅取前 ${limit} 字，已截断 ${cut} 字）\n${md.slice(0, limit)}`,
          );
        }
      } catch (e) {
        logger.error("ai reference load failed", ref.id, e);
      }
    }
    if (parts.length === 0) return "";
    return `【用户 @ 引用的文档】\n${parts.join("\n\n")}`;
  };
  return { maxChars, agentRounds, halvedContextBudget, ctxScope, requestMessages, buildReferenceContext };
};
