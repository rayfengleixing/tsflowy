import { aiChat, type AiChatEvent, type AiChatMessage, type AiToolCallRaw } from "@/lib/ai";
import { extractCalls, hideEditBlock, type AiWriteCall } from "@/lib/ai-edit";
import { aiToolSpecs } from "@/lib/ai-tools";
import { addUsage, contentOf, invalidActionRecord, summaryOf } from "./calls";
import { landAction, previewAction } from "./edit-ops";
import type { AiRequestActions } from "./request-slice";
import type { AiActionRecord, AiGet, AiSet } from "./types";

// 流式轮次这一组「非动作面」助手：一轮请求怎么发（streamRound）、被停止或失败怎么收尾
// （settleIncomplete）、写动作怎么预览落地（planAction / finalizeAssistant）。
// 它们不在 `AiState` 上，是 `runStream` 的内部编排件，所以工厂返回四个具名函数，由 index 解构。
// `cancelledTurns` 是 `const` 的 `Set`、`ctxScope` 是出请求切片里的函数：按引用同名注入，
// 下面四个助手的实现文本一字不用改。真正被 `let` 标量锁住的 `runStream` / `stop` 留在 index。

export const createStreamSlice = (
  set: AiSet,
  get: AiGet,
  { cancelledTurns, ctxScope }: { cancelledTurns: Set<number>; ctxScope: AiRequestActions["ctxScope"] },
) => {
  /** 中断收尾：空的助手占位直接丢弃；有内容的半截回答留下并标记中断类型，重试据此判定重发 */
  const settleIncomplete = (assistantId: string, kind: "error" | "stopped") =>
    set((s) => ({
      messages: s.messages
        .map((m) => (m.id === assistantId ? { ...m, content: m.content.trim(), incomplete: kind } : m))
        .filter((m) => m.id !== assistantId || m.content.trim().length > 0),
    }));

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
  return { settleIncomplete, planAction, finalizeAssistant, streamRound };
};
