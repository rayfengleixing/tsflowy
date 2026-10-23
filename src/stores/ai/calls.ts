import { type AiToolCallRaw, type AiUsage } from "@/lib/ai";
import {
  extractCalls,
  RETRIEVAL_TOOLS,
  validateCall,
  type AiCall,
  type AiWriteCall,
  type RetrievalCall,
  type RetrievalKind,
} from "@/lib/ai-edit";
import { t } from "@/lib/i18n";
import { AiActionRecord } from "./types";
// 指令块与用量的小工具：解析失败的占位卡片、多轮用量合并、读写/检索调用判定与收集。

/** 指令块解析失败的占位卡片：没有可执行的动作，也就没有确认与撤销 */
export function invalidActionRecord(): AiActionRecord {
  return { tool: "invalid", call: null, op: null, summary: "", content: "", before: "", state: "malformed" };
}

/** 一次提问可能跑多轮（每次检索往返都是一个请求），用量合并成本轮合计 */
export function addUsage(turn: AiUsage | null, u: AiUsage): AiUsage {
  return {
    prompt_tokens: (turn?.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
    completion_tokens: (turn?.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
    total_tokens: (turn?.total_tokens ?? 0) + (u.total_tokens ?? 0),
  };
}
export function isRetrievalCall(call: AiCall): call is RetrievalCall {
  return RETRIEVAL_TOOLS.includes(call.tool as RetrievalKind);
}

export function isWriteCall(call: AiCall): call is AiWriteCall {
  return !isRetrievalCall(call);
}

/** 动作的正文内容（diff 预览右侧展示；建页用正文，其余写动作没有整段文本） */
export function contentOf(call: AiWriteCall): string {
  if (call.tool === "apply_edit") return call.args.content;
  if (call.tool === "create_page") return call.args.content ?? "";
  return "";
}

/** 卡片标题：apply_edit 用模型给的 summary，其余动作按参数自动生成一句说明 */
export function summaryOf(call: AiWriteCall): string {
  switch (call.tool) {
    case "apply_edit":
      return call.args.summary ?? "";
    case "create_page":
      return t("ai.actionSummaryCreate", { title: call.args.title });
    case "set_page_title":
      return t("ai.actionSummaryRename", { page: call.args.page, title: call.args.title });
    case "add_database_row":
      return t("ai.actionSummaryAddRow", { database: call.args.database });
    case "update_database_row":
      return t("ai.actionSummaryUpdateRow", { database: call.args.database, row: call.args.row });
    case "delete_database_row":
      return t("ai.actionSummaryDeleteRow", { database: call.args.database, row: call.args.row });
  }
}

/** 本轮模型下发的动作：函数调用与文本协议块合并去重（两条路收敛为同一种形态） */
export function collectCalls(
  refs: AiToolCallRaw[],
  text: string,
): { items: { call: AiCall; id: string }[]; malformed: boolean } {
  const items: { call: AiCall; id: string }[] = [];
  const seen = new Set<string>();
  let malformed = false;
  const push = (call: AiCall, id: string) => {
    const key = JSON.stringify(call);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ call, id });
  };
  for (const r of refs) {
    let value: unknown;
    try {
      value = JSON.parse(r.arguments || "{}");
    } catch {
      malformed = true;
      continue;
    }
    const obj = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    // 函数调用的工具名在 name 字段里，参数体是裸 args；个别模型会把 {tool,args} 整个塞进 arguments，
    // 那种形态直接交给 validateCall（它与文本协议共用同一种 JSON）
    const call = validateCall("tool" in obj || "op" in obj ? obj : { tool: r.name, args: obj });
    if (!call) malformed = true;
    else push(call, r.id);
  }
  const extracted = extractCalls(text);
  for (const c of extracted.calls) push(c, "");
  return { items, malformed: malformed || extracted.malformed };
}
