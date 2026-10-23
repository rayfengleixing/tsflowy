import { create } from "zustand";
import { toast } from "sonner";
import { save } from "@/lib/ipc-dialog";
import { invoke } from "@/lib/invoke";
import { newId } from "@/lib/db";
import {
  aiCancel,
  aiChat,
  aiErrorText,
  aiGetConfig,
  aiSaveConfig,
  aiSessionList,
  aiSessionSave,
  aiSessionDelete,
  aiUsageSummary,
  docSearchSnippets,
  type AiSessionRow,
  type AiChatEvent,
  type AiChatMessage,
  type AiConfig,
  type AiToolCallRaw,
  type AiToolCallRef,
} from "@/lib/ai";
import { getAiEditor, getAiEditorForView } from "@/lib/ai-editor";
import {
  buildEditSystemPrompt,
  buildNoContextSystemPrompt,
  CHAT_ONLY_SYSTEM_PROMPT,
  CTX_SCOPE_PAGE_ONLY_NOTE,
  extractCalls,
  hideEditBlock,
  retrievalResultMessage,
  RETRIEVAL_BLOCKED_BY_SCOPE_NOTE,
  type AiEditAnchor,
  type AiEditOp,
  type AiWriteCall,
  type RetrievalCall,
} from "@/lib/ai-edit";
import { aiToolSpecs, resolvePage, runRetrievalCall, runUndoPlan, runWriteAction } from "@/lib/ai-tools";
import { applyEditToDocJson, asDoc, type LocateFailure } from "@/lib/ai-locate";
import { parseMentions } from "@/lib/ai-mention";
import { estimateTokens, tailTokens } from "@/lib/ai-tokens";
import { documentApi } from "@/lib/documents";
import { jsonToMarkdown } from "@/lib/markdown";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
import { useWorkspaceStore } from "@/stores/workspace";
import type { JSONContent } from "@tiptap/core";
import { parseViewAliases, type ViewNode } from "@/types/models";
import { t, type MessageKey } from "@/lib/i18n";
import { AiActionRecord, AiMessage, AiState, SessionUsage, StoredSession } from "./types";
import {
  addUsage,
  collectCalls,
  contentOf,
  invalidActionRecord,
  isRetrievalCall,
  isWriteCall,
  summaryOf,
} from "./calls";
import { QUICK_PROMPT_KEY, REFINE_SYSTEM_PROMPT, pageTitleFrom, parsePromptIdeas } from "./prompts";
import {
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TOKEN_BUDGET,
  DEFAULT_MAX_CHARS,
  MAX_SESSIONS,
  MAX_WIDTH,
  MIN_WIDTH,
  PANEL_WIDTH_KEY,
  SESSIONS_KEY,
  loadWidth,
} from "./limits";
import { LocalSessions, fromSessionRow, loadSessionsFromStorage, sessionTitle, toSessionRow } from "./session-codec";

// AI 助手面板状态：开关/宽度（localStorage 偏好）、消息列表、流式状态、
// 配置缓存与 send / stop / clear / retry / quickAction / undoAction 动作。

export type { AiActionRecord, AiEditState, AiMessage, AiQuickAction, SessionUsage, StoredSession } from "./types";
export {
  AI_WIDTH_LIMITS,
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TOKEN_BUDGET,
} from "./limits";
export { visibleSessionWindow } from "./session-codec";

/** 当前打开的页面（用于给会话标注上下文来源） */
function currentPageRef(): { id: string; name: string } | null {
  const s = useWorkspaceStore.getState();
  if (!s.currentViewId) return null;
  const node = flattenTree(s.tree).find((v) => v.id === s.currentViewId);
  return { id: s.currentViewId, name: node?.name ?? "" };
}

export const useAiStore = create<AiState>()((set, get) => {
  const restored = loadSessionsFromStorage();

  /** 当前流式中的助手消息 id：stop() 据此标记「用户主动中止的这一轮」 */
  let streamingAssistantId: string | null = null;
  /**
   * 轮次序号与被用户停止的轮次集合：停止后迟到的 done 帧不得再自动落地编辑。
   * 必须是每轮独立 token 而不是单个布尔——旧实现里 stop() 后置 true、
   * 下一次发消息重置 false，被停那轮迟到的 done 会绕过取消判定自动写数据。
   */
  let turnSeq = 0;
  const cancelledTurns = new Set<number>();

  /**
   * 当前对话有内容时归档进 sessions，供 newChat / 切换会话复用。
   * 不再按条数上限淘汰：库里的会话全部保留，显示窗口在面板侧控制，
   * 否则「列表里看得见 100 条、下次 newChat 悄悄删掉 80 条」比截断展示更糟。
   * archived 为刚落档的会话。
   */
  const archiveCurrent = (s: {
    messages: AiMessage[];
    sessions: StoredSession[];
    activeSessionId: string;
    sessionPageId: string | null;
    sessionPageTitle: string | null;
    usageTotal: { prompt: number; completion: number; total: number };
  }): { sessions: StoredSession[]; archived: StoredSession | null } => {
    if (s.messages.length === 0) return { sessions: s.sessions, archived: null };
    const entry: StoredSession = {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
      pageId: s.sessionPageId,
      pageTitle: s.sessionPageTitle,
      usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
    };
    return { sessions: [entry, ...s.sessions], archived: entry };
  };

  /** 会话快照落盘（流式增量不触发，只在轮次结束 / 显式操作时调用） */
  /** 跨会话 token 累计：库不可用时清掉即可，用量条是锦上添花，不该弹错打扰 */
  const fetchUsage = () => {
    void aiUsageSummary()
      .then((v) => set({ usageSummary: v }))
      .catch(() => set({ usageSummary: null }));
  };

  /** localStorage 兜底：只在落库失败时用；配额溢出则丢一半最老的归档重试一次 */
  const writeLocal = (active: StoredSession | null, sessions: StoredSession[]) => {
    const activeId = get().activeSessionId;
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify({ activeId, sessions, active }));
    } catch {
      try {
        localStorage.setItem(
          SESSIONS_KEY,
          JSON.stringify({
            activeId,
            sessions: sessions.slice(0, Math.floor(MAX_SESSIONS / 2)),
            active,
          }),
        );
      } catch (e) {
        logger.warn("ai sessions persist failed", e);
      }
    }
  };

  /** 当前进行中的对话快照；没有消息时为 null（库里不存在空会话行） */
  const activeSnapshot = (): StoredSession | null => {
    const s = get();
    if (s.messages.length === 0) return null;
    return {
      id: s.activeSessionId,
      title: sessionTitle(s.messages),
      updatedAt: Date.now(),
      messages: s.messages,
      pageId: s.sessionPageId,
      pageTitle: s.sessionPageTitle,
      usage: { prompt: s.usageTotal.prompt, completion: s.usageTotal.completion },
    };
  };

  // 默认落库：localStorage 只有约 5MB 配额，长对话写满后会被迫丢弃历史；落库则没有这个上限。
  // 按条 upsert 而非整表覆盖：单条写失败不至于把其它会话一起清掉。
  const saveSession = (session: StoredSession) => {
    void aiSessionSave(toSessionRow(session))
      .then(fetchUsage)
      .catch((e: unknown) => {
        logger.warn("ai session save to db failed, fallback to localStorage", e);
        writeLocal(activeSnapshot(), get().sessions);
      });
  };

  const dropSessions = (ids: string[]) => {
    if (ids.length === 0) return;
    const ops = ids.map((id) => aiSessionDelete(id).catch((e: unknown) => logger.warn("ai session delete failed", e)));
    // 删除影响累计用量：等写请求落地再重取，否则拿到的还是删之前的数
    void Promise.allSettled(ops).then(fetchUsage);
  };

  const persistSessions = () => {
    const active = activeSnapshot();
    if (active) saveSession(active);
  };

  /** 本地（localStorage）那份老数据直接充当当前状态：库不可用、或库与本地都空时走这里 */
  const applyLocal = (local: LocalSessions) =>
    set({
      sessions: local.sessions,
      activeSessionId: local.activeId,
      messages: local.active?.messages ?? [],
      sessionPageId: local.active?.pageId ?? null,
      sessionPageTitle: local.active?.pageTitle ?? null,
      usageTotal: sessionUsageTotal(local.active?.usage),
      sessionsLoaded: true,
    });

  /**
   * 一次性导入老会话：ai_sessions 的建表迁移在 0.8.24 之前从未生效，历史只存在 localStorage。
   * 库空而本地有货时先写进库，全部成功才清掉本地副本 —— 否则下一次启动库里已经有当前会话的行，
   * 本地那份归档就再也读不到了（看起来像用户的历史会话凭空消失）。
   * 返回 false 表示没导成功，调用方继续沿用本地那份，下次启动还会重试。
   */
  const importLocalSessions = async (pending: StoredSession[]): Promise<boolean> => {
    const unique: StoredSession[] = [];
    const seen = new Set<string>();
    for (const s of pending) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      unique.push(s);
    }
    try {
      for (const s of unique) await aiSessionSave(toSessionRow(s));
    } catch (e) {
      logger.warn("ai sessions import from localStorage failed", e);
      return false;
    }
    try {
      localStorage.removeItem(SESSIONS_KEY);
    } catch {
      /* 清不掉只是下次重复导入，按 id upsert 没有副作用 */
    }
    return true;
  };

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
   * 面板里「只改一个字段」的整份回写载荷：`ai_save_config` 是覆盖式保存，
   * 少带一个字段就等于把它悄悄重置成默认值，所以载荷统一由这里生成、只叠增量。
   * profiles 不带 api_key 字段 → Rust 侧按 id 保留各档原有 Key；apiKey=null 表示不改全局 Key。
   */
  const configPayload = (c: AiConfig, over: Record<string, unknown>) => ({
    enabled: c.enabled,
    provider: c.provider,
    protocol: c.protocol,
    baseUrl: c.base_url,
    model: c.model,
    maxChars: c.max_chars,
    confirmEdit: c.confirm_edit,
    temperature: c.temperature,
    thinking: c.thinking,
    ctxTokenBudget: c.ctx_token_budget,
    ctxMaxMessages: c.ctx_max_messages,
    ctxScope: c.ctx_scope,
    maxTokens: c.max_tokens,
    systemPrompt: c.system_prompt,
    profiles: c.profiles,
    activeProfile: c.active_profile,
    quickActions: c.quick_actions,
    useTools: c.use_tools,
    priceInput: c.price_input,
    priceOutput: c.price_output,
    agentRounds: c.agent_rounds,
    firstByteTimeout: c.first_byte_timeout,
    idleTimeout: c.idle_timeout,
    streamRetries: c.stream_retries,
    apiKey: null,
    ...over,
  });

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

  /** 中断收尾：空的助手占位直接丢弃；有内容的半截回答留下并标记中断类型，重试据此判定重发 */
  const settleIncomplete = (assistantId: string, kind: "error" | "stopped") =>
    set((s) => ({
      messages: s.messages
        .map((m) => (m.id === assistantId ? { ...m, content: m.content.trim(), incomplete: kind } : m))
        .filter((m) => m.id !== assistantId || m.content.trim().length > 0),
    }));

  /** 定位失败原因 → 界面文案 */
  const LOCATE_REASON: Record<LocateFailure["reason"], MessageKey> = {
    no_doc: "ai.noPage",
    heading_not_found: "ai.locateHeadingNotFound",
    text_not_found: "ai.locateTextNotFound",
    protected_heading: "ai.locateProtectedHeading",
    bad_structure: "ai.locateBlockedByLock",
  };

  /** 当前编辑器桥接与正在打开的页面（apply_edit 不带 view_id 时的落点） */
  const editorTarget = () => ({
    bridge: getAiEditor(),
    currentId: useWorkspaceStore.getState().currentViewId,
  });

  /** 指定视图的落地桥接：主栏/副栏打开中的页面一律就地走编辑器事务；未打开时返回 null 走 JSON 直写 */
  const bridgeFor = (
    view_id: string | undefined,
    currentBridge: ReturnType<typeof getAiEditor>,
    currentId: string | null,
  ) => {
    if (!view_id) return currentBridge;
    if (currentBridge && currentId === view_id) return currentBridge;
    return getAiEditorForView(view_id);
  };

  /**
   * 对非当前页做定位编辑：save=false 只演练一遍（取 diff 用的改前原文、判断能不能定位到）。
   * JSON 路径没有编辑器事务栈，这样落地的改动无法在界面上「撤销」。
   */
  const editOnPage = async (
    node: ViewNode,
    op: AiEditOp,
    markdown: string,
    anchor: AiEditAnchor | undefined,
    save: boolean,
  ): Promise<{ ok: boolean; before: string; reason?: string }> => {
    try {
      const raw = await documentApi.get(node.id);
      const doc: JSONContent = raw
        ? asDoc(JSON.parse(raw) as JSONContent | JSONContent[])
        : { type: "doc", content: [] };
      const result = applyEditToDocJson(doc, op, markdown, anchor);
      if (!result.ok) return { ok: false, before: "", reason: t(LOCATE_REASON[result.reason]) };
      if (save) await documentApi.save(node.id, JSON.stringify({ ...doc, content: result.content }));
      return { ok: true, before: result.before };
    } catch (e) {
      logger.error("ai cross-page edit failed", node.id, e);
      return { ok: false, before: "", reason: e instanceof Error ? e.message : String(e) };
    }
  };

  /** 动作落点与可行性预览：blocked 非空表示这条动作根本执行不了 */
  const previewAction = async (call: AiWriteCall): Promise<{ before: string; pageName: string; blocked?: string }> => {
    if (call.tool !== "apply_edit") {
      const ref =
        call.tool === "create_page"
          ? call.args.parent_page
          : call.tool === "set_page_title"
            ? call.args.page
            : call.args.database;
      if (!ref) return { before: "", pageName: "" };
      const node = resolvePage(ref);
      if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref }) };
      return { before: "", pageName: node.name };
    }
    const { op, content, anchor, view_id } = call.args;
    const { bridge, currentId } = editorTarget();
    const target = bridgeFor(view_id, bridge, currentId);
    if (target) {
      return { before: target.getEditTargetText(op, anchor), pageName: target.getPageTitle() };
    }
    if (!view_id) return { before: "", pageName: "", blocked: t("ai.noEditor") };
    const node = resolvePage(view_id);
    if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref: view_id }) };
    const dry = await editOnPage(node, op, content, anchor, false);
    return { before: dry.before, pageName: node.name, ...(dry.reason ? { blocked: dry.reason } : {}) };
  };

  /** 真正执行一个动作：当前页走编辑器事务（可撤销），其它页面与库写入走各自路径 */
  const landAction = async (rec: AiActionRecord): Promise<AiActionRecord> => {
    const call = rec.call;
    if (!call) return { ...rec, state: "unavailable" };
    if (call.tool === "apply_edit") {
      const { op, content, anchor, view_id } = call.args;
      const { bridge, currentId } = editorTarget();
      // 打开中的页面（含分栏副栏）必须走编辑器事务：JSON 直写会被该实例自动保存覆盖回去
      const target = bridgeFor(view_id, bridge, currentId);
      if (target) {
        const result = target.applyEdit(op, content, anchor);
        return result.applied
          ? { ...rec, state: "applied", revert: result.revert }
          : { ...rec, state: "unavailable", detail: result.reason ?? t("ai.editNotApplied") };
      }
      if (!view_id) return { ...rec, state: "unavailable", detail: t("ai.noEditor") };
      const node = resolvePage(view_id);
      if (!node) return { ...rec, state: "unavailable", detail: t("ai.toolPageNotFound", { ref: view_id }) };
      const done = await editOnPage(node, op, content, anchor, true);
      if (done.ok) return { ...rec, state: "applied", pageName: node.name };
      return { ...rec, state: "unavailable", pageName: node.name, detail: done.reason };
    }
    const outcome = await runWriteAction(call);
    if (outcome.ok) {
      return {
        ...rec,
        state: "applied",
        detail: outcome.detail,
        // 换逆操作计划要换掉旧的：上一次落地留下的计划撤销的是上一次的改动
        ...(outcome.undo ? { undo: outcome.undo } : {}),
      };
    }
    return { ...rec, state: "unavailable", detail: outcome.detail };
  };

  /** 一条动作先预览、再按设置决定停在待确认还是立即落地（confirm_edit 开启时永不自动写） */
  const planAction = async (call: AiWriteCall, turnId: number): Promise<AiActionRecord> => {
    const preview = await previewAction(call);
    const record: AiActionRecord = {
      tool: call.tool,
      call,
      op: call.tool === "apply_edit" ? call.args.op : null,
      summary: summaryOf(call),
      content: contentOf(call),
      // 改前原文：即便直接落地也留一份，之后随时可以「查看改动」
      before: preview.before,
      pageName: preview.pageName,
      state: "unavailable",
      ...(preview.blocked ? { detail: preview.blocked } : {}),
    };
    if (preview.blocked) return record;
    // 用户按「停止」后迟到的 done 帧不能替用户写数据；与开启确认一样停在待确认
    if (cancelledTurns.has(turnId) || get().config?.confirm_edit) return { ...record, state: "pending" };
    return await landAction(record);
  };

  /** 收尾：正文剥掉指令块，写动作逐条预览落地；检索被丢弃（轮次上限 / 范围关闭）时在正文后说明 */
  const finalizeAssistant = async (
    assistantId: string,
    turnId: number,
    full: string,
    writes: AiWriteCall[],
    malformed: boolean,
    droppedNote: string,
  ) => {
    const display = extractCalls(full).display;
    const note = droppedNote ? `\n\n${droppedNote}` : "";
    if (writes.length === 0) {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: (display.trim() || full) + note,
                // 指令块有问题：正文已剥掉坏块，这里只留一张提示卡片（没有落地动作，也就没有撤销）
                ...(malformed ? { actions: [invalidActionRecord()] } : {}),
              }
            : m,
        ),
      }));
      return;
    }
    const records: AiActionRecord[] = [];
    if (malformed) records.push(invalidActionRecord());
    for (const call of writes) records.push(await planAction(call, turnId));
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              // 正文为空时用第一条动作的说明兜底，保证这条消息留在后续对话上下文里
              content: (display.trim() || records[0].summary) + note,
              actions: records,
            }
          : m,
      ),
    }));
  };

  /**
   * 跑一轮模型请求：raw 累积模型原始输出，state 里只放「去掉指令块」的展示文本。
   * 返回全量文本、函数调用与本轮结局，供 runStream 编排 agent 循环。
   */
  const streamRound = async (
    assistantId: string,
    outgoing: AiChatMessage[],
  ): Promise<{
    full: string;
    refs: AiToolCallRaw[];
    cancelled: boolean;
    failed: { message: string; code: string | null } | null;
  }> => {
    let raw = "";
    let full = "";
    let refs: AiToolCallRaw[] = [];
    let cancelled = false;
    let failed: { message: string; code: string | null } | null = null;
    // 流式节流：每个增量都 set 会重建整条消息数组并重解析 Markdown，长回答会掉帧。
    // 把约 60ms 内的增量合并成一帧提交（约 16 次/秒，肉眼仍是连贯的打字效果）。
    let pendingDelta = "";
    let pendingReasoning = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pendingDelta && !pendingReasoning) return;
      const r = pendingReasoning;
      pendingDelta = "";
      pendingReasoning = "";
      // 正文一律由 raw 重算：指令块开始之后的增量不能显示出来
      const display = hideEditBlock(raw);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: display } : m)),
        reasoning: r ? s.reasoning + r : s.reasoning,
      }));
    };
    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    };
    // 工具定义只在服务商支持函数调用时下发；不支持时模型走文本协议块，能力等价
    // 「仅本页」档连只读检索一起关掉：工具不下发，文本块那条路在 runStream 里同样拒执行
    const tools = get().config?.use_tools && ctxScope() !== "page_only" ? aiToolSpecs() : undefined;
    await aiChat(
      outgoing,
      (ev: AiChatEvent) => {
        if (ev.type === "chunk") {
          raw += ev.delta;
          pendingDelta += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "reasoning") {
          // 推理型模型的思考增量：单独累积，只用于展示，不写进助手消息
          pendingReasoning += ev.delta;
          flushTimer ??= setTimeout(flush, 60);
        } else if (ev.type === "done") {
          // 收尾前先把没来得及提交的增量补上，否则会被 finalize 的结果覆盖
          flushNow();
          full = ev.full || raw;
          refs = ev.tool_calls ?? [];
          const u = ev.usage;
          if (u) {
            set((s) => ({
              usage: addUsage(s.usage, u),
              usageTotal: {
                prompt: s.usageTotal.prompt + (u.prompt_tokens ?? 0),
                completion: s.usageTotal.completion + (u.completion_tokens ?? 0),
                total: s.usageTotal.total + (u.total_tokens ?? 0),
              },
            }));
          }
        } else if (ev.message === "cancelled") {
          // 用户主动「停止」时 Rust 会回 cancelled：不算错误，保留已生成的部分内容
          flushNow();
          cancelled = true;
        } else {
          flushNow();
          failed = { message: ev.message, code: ev.code ?? null };
        }
      },
      tools,
    );
    return { full: full || raw, refs, cancelled, failed };
  };

  /**
   * agent 循环：模型请求 → 若它要求只读检索则本机执行、把结果喂回去再来一轮 →
   * 收敛后统一落地写动作（改文档 / 建页 / 改标题 / 加表行）。
   * 循环放在前端而不是 Rust：页面树、文档、数据库与编辑器的权威状态都在前端。
   */
  const runStream = async (assistantId: string) => {
    streamingAssistantId = assistantId;
    const turnId = ++turnSeq;
    /**
     * 本轮是否被用户「停止」：stop() 只标记当前轮号。aiCancel 只能掐断飞行中的请求，
     * 轮次间隙与检索执行阶段没有请求在跑，必须靠循环自己在各边界核对这个标记。
     */
    const cancelledByUser = () => cancelledTurns.has(turnId);
    // usage 是「本轮合计」：先清零，多轮往返才不会被上一轮的用量掺进来
    // retrieving 一并清掉：被停的旧循环可能还挂在检索 await 上，标志是它留下的旧值
    set({ usage: null, retrieving: false });
    // 范围在一轮对话开始时定一次：中途改设置不该让同一轮的前后半段口径不一致
    const scope = ctxScope();
    // 轮次上限也在本轮开始时取一次：中途改设置不该让同一轮的前后半段口径不一致
    const roundLimit = agentRounds();
    // @ 引用的文档要先读盘转文本，再随 system 一起下发；「仅本页」档不带其它文档
    const referenceContext = scope === "page_only" ? "" : await buildReferenceContext();
    let outgoing = requestMessages(assistantId, referenceContext);
    // 选中内容只随本轮生效：消息组装完就清掉，下一轮不再重复带
    if (get().pendingContext) set({ pendingContext: null });
    const writes: AiWriteCall[] = [];
    let lastFull = "";
    let malformed = false;
    let droppedNote = "";
    let cancelled = false;
    let failed: { message: string; code: string | null } | null = null;
    /**
     * 模型窗口比配置的上下文预算小时，服务端直接报超限。这里最多降预算补发两次（每次砍一半），
     * 让用户至少能把这一问问完；一旦检索结果已经拼进 outgoing 就不再重建（重建会丢掉检索内容），
     * 预算低于 500 token 也停手——截到那种长度的对话接不上，不如把报错交给用户。
     */
    let contextShrinks = 0;
    let outgoingGrew = false;
    let shrinkNote = "";
    try {
      for (let round = 0; round < roundLimit; round++) {
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        const result = await streamRound(assistantId, outgoing);
        lastFull = result.full;
        cancelled = result.cancelled;
        failed = result.failed;
        if (!cancelled && failed?.code === "context_length" && !outgoingGrew && contextShrinks < 2) {
          const smaller = halvedContextBudget();
          if (smaller !== null) {
            contextShrinks++;
            shrinkNote = t("ai.contextBudgetRetried", { budget: smaller });
            outgoing = requestMessages(assistantId, referenceContext, smaller);
            failed = null;
            lastFull = "";
            // 半截的回答不能和重发后的答案叠在一起，与检索轮一样清空
            set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
            continue;
          }
        }
        if (cancelled || failed) break;
        const { items, malformed: bad } = collectCalls(result.refs, result.full);
        malformed = malformed || bad;
        for (const x of items) if (isWriteCall(x.call)) writes.push(x.call);
        const retrievals = items.filter((x) => isRetrievalCall(x.call));
        if (retrievals.length === 0) break;
        // 「仅本页」档：检索一概不执行。工具没下发，但文本协议块仍可能出现（模型照旧想查），
        // 这里把原因回灌再要一轮答案，否则正文会停在「我先查一下」这种半句话
        if (scope === "page_only") {
          droppedNote = t("ai.searchScopeBlocked");
          outgoing = [
            ...outgoing,
            { role: "assistant", content: result.full },
            { role: "system" as const, content: RETRIEVAL_BLOCKED_BY_SCOPE_NOTE },
          ];
          outgoingGrew = true;
          set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
          continue;
        }
        // 往返已到上限：不再执行检索（结果没机会进答案），只在正文后说明一句
        if (round + 1 >= roundLimit) {
          droppedNote = t("ai.searchRoundLimit", { max: roundLimit });
          break;
        }
        // 此处到 set(retrieving:true) 之间没有 await：停止只可能发生在 await 边界，检查一次即够
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        set({ retrieving: true });
        const toolMode = !!get().config?.use_tools;
        const limit = maxChars();
        const toolRefs: AiToolCallRef[] = [];
        const toolMsgs: AiChatMessage[] = [];
        const plain: { tool: string; result: string }[] = [];
        try {
          for (const [i, x] of retrievals.entries()) {
            if (cancelledByUser()) break;
            const call = x.call as RetrievalCall;
            // 函数调用回灌要带原 id；文本协议块没有 id，按序号造一个配套的（assistant 消息里一并声明）
            const id = x.id || `tcall_${round}_${i}`;
            const output = await runRetrievalCall(call.tool, call.args, limit);
            toolRefs.push({
              id,
              type: "function",
              function: { name: call.tool, arguments: JSON.stringify(call.args) },
            });
            if (toolMode) toolMsgs.push({ role: "tool", content: output, tool_call_id: id });
            else plain.push({ tool: call.tool, result: output });
          }
        } finally {
          // 新轮已开始（用户停止后立刻重发）时不再动全局标志，归新轮自己管
          if (turnSeq === turnId) set({ retrieving: false });
        }
        if (cancelledByUser()) {
          cancelled = true;
          break;
        }
        outgoing = [
          ...outgoing,
          { role: "assistant", content: result.full, ...(toolMode ? { tool_calls: toolRefs } : {}) },
          ...(toolMode ? toolMsgs : [{ role: "system" as const, content: retrievalResultMessage(plain) }]),
        ];
        outgoingGrew = true;
        // 下一轮的答案才是给用户看的：本轮文本（多半只是「我先查一下」）清掉，免得两轮内容叠在一起
        set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)) }));
      }
      if (failed) {
        set({ error: failed.message, errorCode: failed.code });
        settleIncomplete(assistantId, "error");
      } else if (cancelled) {
        settleIncomplete(assistantId, "stopped");
      } else {
        // 降预算补发成功时也要告诉用户这次是按更小的上下文答的，否则他会以为历史全在
        const note = [droppedNote, shrinkNote].filter(Boolean).join("\n");
        await finalizeAssistant(assistantId, turnId, lastFull, writes, malformed, note);
      }
    } catch (e) {
      // 起手就失败（未配置 / 命令报错）：没有归类码，界面按通用错误处理
      set({ error: aiErrorText(e), errorCode: null });
      settleIncomplete(assistantId, "error");
    } finally {
      cancelledTurns.delete(turnId);
      // 用户停止后又发起了新提问：streaming 状态与在途消息归属新一轮，旧循环不得替它拆掉
      if (turnSeq === turnId) {
        set({ streaming: false, retrieving: false });
        streamingAssistantId = null;
      }
      // 一轮结束（含失败/取消）后落盘，流式增量期间不写
      persistSessions();
    }
  };

  /** 库里存的用量 → 面板用的累计三元组（老会话没单独记 total，用输入+输出兜底） */
  const sessionUsageTotal = (u?: SessionUsage) => ({
    prompt: u?.prompt ?? 0,
    completion: u?.completion ?? 0,
    total: (u?.prompt ?? 0) + (u?.completion ?? 0),
  });

  return {
    open: false,
    width: loadWidth(),
    messages: restored.active?.messages ?? [],
    sessions: restored.sessions,
    activeSessionId: restored.active?.id ?? restored.activeId,
    reasoning: "",
    streaming: false,
    retrieving: false,
    error: null,
    errorCode: null,
    sessionPageId: null,
    sessionPageTitle: null,
    sessionsLoaded: false,
    sessionsShown: MAX_SESSIONS,
    usage: null,
    usageTotal: sessionUsageTotal(restored.active?.usage),
    usageSummary: null,
    config: null,
    configLoaded: false,
    pendingContext: null,
    focusTick: 0,
    editingId: null,
    promptIdeas: [],
    refining: false,

    toggle: () => set((s) => ({ open: !s.open })),
    // 打开面板的同时请求聚焦输入框：编辑器里点「问 AI」后可以立刻开始打字
    openPanel: () => set((s) => ({ open: true, focusTick: s.focusTick + 1 })),
    closePanel: () => set({ open: false }),
    setWidth: (w) => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
      set({ width });
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(width));
      } catch {
        /* localStorage 不可用时静默降级 */
      }
    },

    loadConfig: async () => {
      try {
        const config = await aiGetConfig();
        set({ config, configLoaded: true });
      } catch (e) {
        set({ configLoaded: true, error: aiErrorText(e) });
      }
    },

    // 历史会话优先从库里读（localStorage 只有约 5MB 配额）；库为空或不可用时再用本地老数据
    loadSessions: async () => {
      if (get().sessionsLoaded) return;
      const local = loadSessionsFromStorage();
      let rows: AiSessionRow[];
      try {
        rows = await aiSessionList();
      } catch (e) {
        logger.warn("ai sessions load from db failed, fallback to localStorage", e);
        applyLocal(local);
        return;
      }
      // 库按 updated_at 降序返回。全部保留：历史上超出的会话曾因不可见又被静默删除，
      // 现在改由面板显示窗口（sessionsShown）控制，数据一条不丢。
      const all: StoredSession[] = [];
      for (const r of rows) {
        const s = fromSessionRow(r);
        if (s) all.push(s);
      }
      if (all.length === 0) {
        const pending = [local.active, ...local.sessions].filter((s): s is StoredSession => s !== null);
        // 导入失败（或本地本来就没会话）就沿用本地那份，下次启动还会重试
        if (pending.length === 0 || !(await importLocalSessions(pending))) {
          applyLocal(local);
          return;
        }
        // 保持本地那份的当前会话在第一位，切过来还是用户正在看的那段对话
        all.push(...pending);
      }
      // 当前对话取最近一条未归档的；全被归档了就退回最近那条
      const fresh = all.findIndex((x) => !x.archived);
      const active = all[fresh < 0 ? 0 : fresh];
      set({
        messages: active.messages,
        activeSessionId: active.id,
        sessions: all.filter((x) => x.id !== active.id),
        sessionPageId: active.pageId ?? null,
        sessionPageTitle: active.pageTitle ?? null,
        usageTotal: sessionUsageTotal(active.usage),
        sessionsLoaded: true,
      });
      fetchUsage();
    },

    loadMoreSessions: () => set((s) => ({ sessionsShown: s.sessionsShown + MAX_SESSIONS })),
    setConfig: (config) => set({ config, configLoaded: true }),
    setPendingContext: (text) => set({ pendingContext: text }),

    send: async (text, images) => {
      const content = text.trim();
      // 只带图、不打字也算一次提问；两者皆空才忽略
      if ((!content && !images?.length) || get().streaming) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      // 会话首条消息：记下发起时所在的页面，之后历史会话列表能标注它的上下文来源
      const pageRef = get().messages.length === 0 ? currentPageRef() : null;
      set((s) => ({
        open: true,
        error: null,
        errorCode: null,
        reasoning: "",
        streaming: true,
        promptIdeas: [],
        // 普通提问（含快捷动作）会往列表追加内容，此前「改后重发」的目标不再有效
        editingId: null,
        messages: [
          ...s.messages,
          { id: newId(), role: "user", content, ...(images?.length ? { images } : {}) },
          assistant,
        ],
        ...(pageRef ? { sessionPageId: pageRef.id, sessionPageTitle: pageRef.name } : {}),
      }));
      // 用户消息先落盘，流式中途崩溃也不丢提问
      persistSessions();
      await runStream(assistant.id);
    },

    stop: () => {
      // 标记本轮被用户停止：之后即便 Rust 尾帧（done）晚一步到达，也不会自动落地编辑。
      // 只标记「当时正在流的那一轮」，不影响用户随后立刻发起的新轮。
      // agent 循环在每轮开始与每个检索步骤前核对这个标记：aiCancel 只掐得断飞行中的请求，
      // 检索/工具执行阶段没有请求在跑，靠循环自己在边界退出。
      if (streamingAssistantId) cancelledTurns.add(turnSeq);
      aiCancel().catch(() => undefined);
      set({ streaming: false });
    },

    clear: () => {
      const hadContent = get().messages.length > 0;
      const oldId = get().activeSessionId;
      set({
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      // 清空即销毁这一会话：按 id 删除它的库行，而不是留下空壳
      if (hadContent) dropSessions([oldId]);
    },

    /** 归档当前对话并开始新会话 */
    newChat: () => {
      const { sessions, archived } = archiveCurrent(get());
      set({
        sessions,
        messages: [],
        reasoning: "",
        error: null,
        errorCode: null,
        editingId: null,
        promptIdeas: [],
        // 新会话的关联页面等第一条消息时再定
        sessionPageId: null,
        sessionPageTitle: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
        activeSessionId: newId(),
      });
      if (archived) saveSession(archived);
    },

    /** 切换到历史会话（当前对话有内容时先归档；流式进行中不允许切） */
    switchSession: (id) => {
      const s = get();
      if (s.streaming) return;
      const target = s.sessions.find((x) => x.id === id);
      if (!target) return;
      const rest = s.sessions.filter((x) => x.id !== id);
      const archived = archiveCurrent({ ...s, sessions: rest });
      set({
        sessions: archived.sessions,
        messages: target.messages,
        activeSessionId: target.id,
        sessionPageId: target.pageId ?? null,
        sessionPageTitle: target.pageTitle ?? null,
        reasoning: "",
        error: null,
        errorCode: null,
        // 换会话后消息列表整个换掉，待修改的提问 id 不再指向任何消息
        editingId: null,
        promptIdeas: [],
        // 累计用量按会话统计：切过去先接上它自己那份历史用量，本轮再往上累加
        usage: null,
        usageTotal: sessionUsageTotal(target.usage),
      });
      if (archived.archived) saveSession(archived.archived);
    },

    deleteSession: (id) => {
      if (get().streaming) return;
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
      dropSessions([id]);
    },

    // 改名与归档都只动历史列表里的那一行：整行 upsert，不需要额外的命令
    renameSession: (id, rawTitle) => {
      const title = rawTitle.trim().slice(0, 60);
      const target = get().sessions.find((x) => x.id === id);
      if (!title || !target || target.title === title) return;
      const next = { ...target, title };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },

    setSessionArchived: (id, archived) => {
      const target = get().sessions.find((x) => x.id === id);
      if (!target || target.archived === archived) return;
      const next = { ...target, archived };
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? next : x)) }));
      saveSession(next);
    },

    // 评分写在消息上，随会话整条落库；点同一次即取消（rating 置 undefined，序列化时自然消失）
    rateMessage: (messageId, rating) => {
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          return m.rating === rating ? { ...m, rating: undefined } : { ...m, rating };
        }),
      }));
      persistSessions();
    },

    retry: async () => {
      if (get().streaming) return;
      const msgs = [...get().messages];
      // 失败/停止留下的半截回答：整条丢弃后重发这一问（想接着半截往下写走「继续生成」）
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant" && msgs[msgs.length - 1].incomplete) msgs.pop();
      // 去掉尾部失败/空的助手消息，回到最后一条用户消息重发
      while (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant" && !msgs[msgs.length - 1].content.trim()) {
        msgs.pop();
      }
      if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        messages: [...msgs, assistant],
        reasoning: "",
        streaming: true,
        error: null,
        errorCode: null,
      });
      await runStream(assistant.id);
    },

    // 快捷动作：总结当前页取整页纯文本（按 max_chars 截断）；其余三个用选中文本
    quickAction: async (kind) => {
      const bridge = getAiEditor();
      const limit = maxChars();
      // 续写不需要选中：整页上下文已随 system prompt 下发，只要文档在就行
      if (kind === "continue") {
        if (!bridge) {
          toast.error(t("ai.noPage"));
          return;
        }
        await get().send(t(QUICK_PROMPT_KEY[kind]));
        return;
      }
      let content: string;
      if (kind === "summarize") {
        const page = bridge?.getPageText().trim() ?? "";
        if (!page) {
          toast.error(t("ai.noPage"));
          return;
        }
        content = page.slice(0, limit);
      } else {
        const selection = bridge?.getSelectionText().trim() ?? "";
        if (!selection) {
          toast.error(t("ai.noSelection"));
          return;
        }
        content = selection;
      }
      await get().send(t(QUICK_PROMPT_KEY[kind], { content }));
    },

    // 撤销一个已落地的动作：页面/表数据按落库时留下的逆操作计划回滚（重启后仍撤得动），
    // 文档编辑按当前编辑器 undo 栈里的改前快照回滚，撤不动时明确告知而不是静默撤掉用户的编辑
    undoAction: async (messageId, index) => {
      const rec = get().messages.find((m) => m.id === messageId)?.actions?.[index];
      if (!rec) return;
      const markUndone = () => {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === messageId && m.actions
              ? { ...m, actions: m.actions.map((a, i) => (i === index ? { ...a, undone: true } : a)) }
              : m,
          ),
        }));
        persistSessions();
      };
      if (rec.undo) {
        const done = await runUndoPlan(rec.undo);
        if (!done.ok) {
          toast.error(done.detail);
          return;
        }
        toast.success(done.detail);
        markUndone();
        return;
      }
      const bridge = getAiEditor();
      if (!bridge || !rec.revert) return;
      if (!bridge.undoAiEdit(rec.revert)) {
        toast.error(t("ai.undoFailed"));
        return;
      }
      markUndone();
    },

    // 用户在 diff 预览后点「应用」：这才真正写数据（文档 / 页面 / 表格）
    applyAction: async (messageId, index) => {
      const s = get();
      const msg = s.messages.find((m) => m.id === messageId);
      const rec = msg?.actions?.[index];
      if (!msg || rec?.state !== "pending") return;
      const landed = await landAction(rec);
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId && m.actions ? { ...m, actions: m.actions.map((a, i) => (i === index ? landed : a)) } : m,
        ),
      }));
      if (landed.state === "applied") toast.success(t("ai.actionAppliedToast"));
      persistSessions();
    },

    rejectAction: (messageId, index) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId && m.actions
            ? {
                ...m,
                actions: m.actions.map((a, i) =>
                  i === index && a.state === "pending" ? { ...a, state: "rejected" } : a,
                ),
              }
            : m,
        ),
      }));
      persistSessions();
    },

    // 切换档位：只改 active_profile，其余配置原样回传
    switchProfile: async (id) => {
      const c = get().config;
      if (!c) return;
      try {
        await aiSaveConfig(configPayload(c, { activeProfile: id }));
        set({ config: await aiGetConfig() });
      } catch (e) {
        logger.error("ai switch profile failed", e);
        toast.error(t("ai.errorPrefix", { message: String(e) }));
      }
    },

    // 上下文范围：面板顶部就能改，改完立即生效（下一轮请求按新范围组装）
    setCtxScope: async (scope) => {
      const c = get().config;
      if (!c || c.ctx_scope === scope) return;
      try {
        await aiSaveConfig(configPayload(c, { ctxScope: scope }));
        set({ config: await aiGetConfig() });
      } catch (e) {
        logger.error("ai set context scope failed", e);
        toast.error(t("ai.errorPrefix", { message: String(e) }));
      }
    },

    // 自定义快捷指令：按 scope 取文本填进模板的 {content} 占位符
    runQuickAction: async (action) => {
      const bridge = getAiEditor();
      let content = "";
      if (action.scope === "selection") {
        content = bridge?.getSelectionText().trim() ?? "";
        if (!content) {
          toast.error(t("ai.noSelection"));
          return;
        }
      } else if (action.scope === "page") {
        content = (bridge?.getPageText().trim() ?? "").slice(0, maxChars());
        if (!content) {
          toast.error(t("ai.noPage"));
          return;
        }
      }
      const prompt = action.prompt.includes("{content}")
        ? action.prompt.replace("{content}", content)
        : content
          ? `${action.prompt}\n\n${content}`
          : action.prompt;
      await get().send(prompt);
    },

    // 继续生成：半截回答留在上下文里再问一次，模型会接着往下写（不重复已有内容）
    continueGenerate: async () => {
      const s = get();
      const total = s.messages.length;
      if (s.streaming || total === 0) return;
      if (s.messages[total - 1].role !== "assistant") return;
      await s.send(t("ai.continueGeneratePrompt"));
    },

    regenerate: async (messageId) => {
      const s = get();
      if (s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      // 只重跑助手回答，且它前面得有可供重问的提问
      if (i < 0 || s.messages[i].role !== "assistant" || !s.messages.slice(0, i).some((m) => m.role === "user")) return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        messages: [...s.messages.slice(0, i), assistant],
        editingId: null,
        promptIdeas: [],
        reasoning: "",
        error: null,
        errorCode: null,
        streaming: true,
      });
      await runStream(assistant.id);
    },

    resend: async (messageId, text, images) => {
      const content = text.trim();
      const s = get();
      if ((!content && !images?.length) || s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      if (i < 0 || s.messages[i].role !== "user") return;
      const assistant: AiMessage = { id: newId(), role: "assistant", content: "" };
      set({
        editingId: null,
        promptIdeas: [],
        messages: [...s.messages.slice(0, i), { ...s.messages[i], content, ...(images ? { images } : {}) }, assistant],
        reasoning: "",
        error: null,
        errorCode: null,
        streaming: true,
      });
      persistSessions();
      await runStream(assistant.id);
    },

    // 改后重发的入口：只标记目标提问，正文由面板填回输入框，用户改完再发送
    startEdit: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const msg = s.messages.find((m) => m.id === messageId);
      if (msg?.role === "user") set({ editingId: messageId, promptIdeas: [] });
    },
    cancelEdit: () => set({ editingId: null }),

    branchFrom: (messageId) => {
      const s = get();
      if (s.streaming) return;
      const i = s.messages.findIndex((m) => m.id === messageId);
      if (i < 0) return;
      const prefix = s.messages.slice(0, i + 1);
      // 原对话整段归档保留，分支是一个新会话，两条线互不影响
      const { sessions, archived } = archiveCurrent(s);
      const branch: StoredSession = {
        id: newId(),
        title: sessionTitle(prefix),
        updatedAt: Date.now(),
        messages: prefix,
        pageId: s.sessionPageId,
        pageTitle: s.sessionPageTitle,
      };
      set({
        sessions,
        messages: prefix,
        activeSessionId: branch.id,
        editingId: null,
        promptIdeas: [],
        reasoning: "",
        error: null,
        errorCode: null,
        usage: null,
        usageTotal: { prompt: 0, completion: 0, total: 0 },
      });
      if (archived) saveSession(archived);
      saveSession(branch);
    },

    saveMessageAsPage: async (messageId) => {
      const msg = get().messages.find((m) => m.id === messageId);
      const content = msg?.content.trim();
      if (!content) return;
      try {
        const outcome = await runWriteAction({
          tool: "create_page",
          args: { title: pageTitleFrom(content), content },
        });
        if (outcome.ok) toast.success(outcome.detail);
        else toast.error(outcome.detail);
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    },

    exportMessage: async (messageId) => {
      const msg = get().messages.find((m) => m.id === messageId);
      const content = msg?.content.trim();
      if (!content) return;
      // 走 Rust 侧 write_text_file：路径由保存对话框授权，与页面/CSV 导出同一口径
      const target = await save({
        defaultPath: `${pageTitleFrom(content).replace(/[\\/:*?"<>|]/g, "-")}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return;
      try {
        await invoke("write_text_file", { path: target, content });
        toast.success(t("settings.exportedFile", { path: target }));
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    },

    refinePrompt: async (text) => {
      const question = text.trim();
      if (!question || get().streaming || get().refining) return;
      set({ refining: true, promptIdeas: [] });
      // 改写是一次性请求，不进对话：错误单独收集，别把面板的 error 状态污染成「这一轮失败」
      const state: { full: string; failed: string | null } = { full: "", failed: null };
      try {
        await aiChat(
          [
            { role: "system", content: REFINE_SYSTEM_PROMPT },
            { role: "user", content: question },
          ],
          (ev: AiChatEvent) => {
            if (ev.type === "done") state.full = ev.full;
            else if (ev.type === "error") state.failed = ev.message;
          },
        );
      } catch (e) {
        state.failed = aiErrorText(e);
      }
      set({ refining: false });
      if (state.failed) {
        toast.error(t("ai.errorPrefix", { message: state.failed }));
        return;
      }
      const ideas = parsePromptIdeas(state.full).filter((x) => x !== question);
      if (ideas.length === 0) {
        toast.error(t("ai.refineNone"));
        return;
      }
      set({ promptIdeas: ideas });
    },
    clearPromptIdeas: () => set({ promptIdeas: [] }),
  };
});
