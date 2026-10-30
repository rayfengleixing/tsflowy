// 从模型回复的文本里找指令代码块：扫描（含流式未闭合）、剥离、逐块解析，以及流式展示时把块藏住。
// 从 lib/ai-edit.ts 原样搬出（逐行零改动）。
import { CALL_BLOCK_TAG, EDIT_BLOCK_TAG, FENCE, type AiCall } from "./types";
import { validateCall } from "./validate";

/** 提取结果：calls 为全部合法动作；malformed 表示「有指令块但没能解析」，界面应提示而不是展示裸 JSON */
export interface ExtractCallsResult {
  calls: AiCall[];
  /** 是否出现动作块（含坏块）：决定流式期间要不要隐藏 */
  hasBlocks: boolean;
  display: string;
  malformed: boolean;
}

interface RawBlock {
  json: string;
  isCall: boolean;
}

/** 扫描文本中所有指令块（含未闭合的最后一个） */
function scanBlocks(text: string): { blocks: RawBlock[]; hasAny: boolean } {
  const blocks: RawBlock[] = [];
  const tags = [EDIT_BLOCK_TAG, CALL_BLOCK_TAG];
  let cursor = 0;
  let hasAny = false;
  for (;;) {
    let best = -1;
    let bestTag = "";
    for (const tag of tags) {
      const idx = text.indexOf(FENCE + tag, cursor);
      if (idx !== -1 && (best === -1 || idx < best)) {
        best = idx;
        bestTag = tag;
      }
    }
    if (best === -1) break;
    hasAny = true;
    const bodyStart = text.indexOf("\n", best);
    if (bodyStart === -1) {
      // 只有标记、没有内容（流式被截断在标记那一行）：视为残缺块
      blocks.push({ json: "", isCall: bestTag === CALL_BLOCK_TAG });
      break;
    }
    const end = text.indexOf(FENCE, bodyStart);
    if (end === -1) {
      // 未闭合围栏：取到文本末尾（流式截断场景）
      blocks.push({ json: text.slice(bodyStart), isCall: bestTag === CALL_BLOCK_TAG });
      cursor = text.length;
      break;
    }
    blocks.push({ json: text.slice(bodyStart, end), isCall: bestTag === CALL_BLOCK_TAG });
    cursor = end + FENCE.length;
  }
  return { blocks, hasAny };
}

/** 删掉文本中所有指令块（含未闭合的），只留下给用户看的正文 */
function stripBlocks(text: string): string {
  const firstIdx = (): { idx: number } => {
    let best = -1;
    for (const tag of [EDIT_BLOCK_TAG, CALL_BLOCK_TAG]) {
      const idx = text.indexOf(FENCE + tag);
      if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    return { idx: best };
  };
  if (firstIdx().idx === -1) return text.trim();
  // 逐块移除：与 scanBlocks 相同的扫描顺序，只保留块与块之间的正文
  let out = "";
  let cursor = 0;
  for (;;) {
    let best = -1;
    for (const tag of [EDIT_BLOCK_TAG, CALL_BLOCK_TAG]) {
      const idx = text.indexOf(FENCE + tag, cursor);
      if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    if (best === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, best);
    const bodyStart = text.indexOf("\n", best);
    if (bodyStart === -1) break;
    const end = text.indexOf(FENCE, bodyStart);
    if (end === -1) break;
    cursor = end + FENCE.length;
  }
  // 块前后的空行会成对保留下来（每剥一个块多出一组换行），压回普通段落间距
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 从模型回复里提取全部动作指令，并给出「去掉指令块之后」的展示文本。
 *
 * 每个合法块都是一个动作；apply_edit 允许多个（旧的「取最后一个」语义保留：
 * 若存在多个 apply_edit 且其中任意一个解析失败，只坏那一个）。
 * 块存在但 JSON 不合法时置 malformed——展示裸 JSON 对用户毫无意义，
 * 但正文（所有指令块之外的部分）仍完整保留，不会静默吞掉答案。
 */
export function extractCalls(text: string): ExtractCallsResult {
  const { blocks, hasAny } = scanBlocks(text);
  if (!hasAny) return { calls: [], hasBlocks: false, display: text, malformed: false };
  const calls: AiCall[] = [];
  let malformed = false;
  for (const b of blocks) {
    const body = b.json.trim();
    if (!body) {
      malformed = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      malformed = true;
      continue;
    }
    const call = validateCall(parsed);
    if (!call) malformed = true;
    else calls.push(call);
  }
  return { calls, hasBlocks: true, display: stripBlocks(text), malformed };
}

/**
 * 兼容旧调用点：从回复里提取「编辑指令」形态的动作。
 * 返回最后一个 apply_edit；检索请求块不计入。
 */
export function extractEdit(text: string): { edit: AiCall | null; display: string; malformed: boolean } {
  const r = extractCalls(text);
  const edits = r.calls.filter((c): c is Extract<AiCall, { tool: "apply_edit" }> => c.tool === "apply_edit");
  return { edit: edits.length > 0 ? edits[edits.length - 1] : null, display: r.display, malformed: r.malformed };
}

/**
 * 流式展示用：把还没写完的动作/检索块藏起来。
 * 指令是一段 JSON，逐字流式显示又长又难看，而且它并不是给用户看的答案。
 * 注意：一旦第一个协议块出现，其后所有内容都隐藏（模型可能先输出动作块再补一个，
 * 中间文本按协议不该出现，隐藏比展示裸 JSON 安全）。
 */
export function hideEditBlock(text: string): string {
  let best = -1;
  for (const tag of [EDIT_BLOCK_TAG, CALL_BLOCK_TAG]) {
    const idx = text.indexOf(FENCE + tag);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best === -1 ? text : text.slice(0, best);
}
