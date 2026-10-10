// AI 助手动作协议：定义与解析。
//
// 模型（任意 OpenAI 兼容服务商）通过带标记的代码块回传「动作指令」，
// 前端解析后落地（改文档 / 建页面 / 查数据库等）。之所以不只依赖 tool_calls：
// 内置的 Ollama 等本地服务商对函数调用支持参差不齐，而「文本里带约定代码块」所有服务商都支持。
// 两条路最终收敛为同一种形态（AiCall），落地逻辑不必分叉。

/**
 * 文档编辑指令的作用范围。
 * 刻意不含「整篇重写」：文档首行 H1 是标题、第二行分割线由 DocumentStructureLock
 * 保护，整篇替换的事务必然被拦截（见 features/editor/extensions/document-structure-lock.ts）。
 * 后三个是定位类 op：用 anchor 指明位置（heading=定位标题，text=定位原文），
 * 可以配合 view_id 作用于其它已入库的页面。
 */
export type AiEditOp =
  | "replace_selection"
  | "insert_at_cursor"
  | "append_to_document"
  | "insert_under_heading"
  | "replace_under_heading"
  | "replace_text";

export const AI_EDIT_OPS: readonly AiEditOp[] = [
  "replace_selection",
  "insert_at_cursor",
  "append_to_document",
  "insert_under_heading",
  "replace_under_heading",
  "replace_text",
];

/** 定位类 op 必须给出锚点：heading 优先（标题文本），text 用于 replace_text（被替换的原文） */
export interface AiEditAnchor {
  heading?: string;
  text?: string;
}

/** 模型下发的一个动作（文档编辑 / 建页 / 改名 / 加行 / 只读检索） */
export type AiCall =
  | {
      tool: "apply_edit";
      args: { op: AiEditOp; summary?: string; content: string; anchor?: AiEditAnchor; view_id?: string };
    }
  | { tool: "create_page"; args: { title: string; content?: string; parent_page?: string } }
  | { tool: "set_page_title"; args: { page: string; title: string } }
  | { tool: "add_database_row"; args: { database: string; cells?: Record<string, unknown> } }
  | { tool: RetrievalKind; args: Record<string, unknown> };

/** 只读检索类工具：前端就地执行、把结果喂回模型，不产生确认卡片 */
export type RetrievalKind =
  "search_workspace" | "list_pages" | "get_page_content" | "list_database_fields" | "query_database";

export const RETRIEVAL_TOOLS: readonly RetrievalKind[] = [
  "search_workspace",
  "list_pages",
  "get_page_content",
  "list_database_fields",
  "query_database",
];

/** 只读检索动作本体 */
export type RetrievalCall = Extract<AiCall, { tool: RetrievalKind }>;

export const WRITE_TOOLS = ["apply_edit", "create_page", "set_page_title", "add_database_row"] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];

/** 会改动用户数据的动作（其余为只读检索） */
export type AiWriteCall = Extract<AiCall, { tool: WriteTool }>;

/** 动作指令代码块的标记语言名（沿用历史名，旧会话与旧配置无需迁移） */
export const EDIT_BLOCK_TAG = "tsflowy-edit";

/** 只读检索请求块的标记：模型输出它表示「先帮我查，我拿到结果再作答」 */
export const CALL_BLOCK_TAG = "tsflowy-call";

const FENCE = "```";

/** 文档上下文：随 system prompt 一并下发，让模型知道「改哪里」 */
export interface AiEditContext {
  title: string;
  /** 当前选中的文本；为空表示没有选区 */
  selection: string;
  /** 当前文档纯文本（调用方按 max_chars 截断过） */
  pageText: string;
}

const PROTOCOL = `你是 TsFlowy 笔记应用内置的助手，可以直接操作用户的知识库：修改文档、创建页面、写入数据库。

【动作协议】
当用户要求你修改、重写、润色、续写、翻译、补充文档，或要求你创建页面、往数据库加记录时，
除了正常作答，还必须在回复最后输出一个或多个动作指令代码块，格式严格如下：

\`\`\`${EDIT_BLOCK_TAG}
{"tool":"apply_edit","args":{"op":"replace_selection","summary":"一句话说明这次改了什么","content":"修改后的 Markdown 内容"}}
\`\`\`

tool 只能取：apply_edit（改文档）/ create_page（建页面，args: title, content?, parent_page?）/
set_page_title（改页面标题，args: page, title）/ add_database_row（加表行，args: database, cells 字段名→值）。
apply_edit 的 op 只能取：
- replace_selection：替换用户当前选中的文字（用户没有选中时退化为在光标处插入）。最常用。
- insert_at_cursor：在光标处插入
- append_to_document：追加到文档末尾
- insert_under_heading：插入到某标题小节的末尾，args 需带 anchor.heading（如 "## 背景" 或 "背景"）
- replace_under_heading：替换某标题之下的整节内容（标题本身不动），args 需带 anchor.heading
- replace_text：替换定位到的原文，args 需带 anchor.text（文档中确实存在的一段文字）
- apply_edit 可选带 view_id：作用于其它页面（按页面 id）；缺省为当前页面。
create_page / set_page_title / add_database_row 可选带 view_id 参数以定位页面，缺省按标题/表名匹配。

【检索请求】
需要更多信息时（全库搜索、浏览页面列表、读取某页正文、查看表结构、查询表数据），
输出检索请求块，前端会执行并把结果反馈给你，然后你再作答：

\`\`\`${CALL_BLOCK_TAG}
{"tool":"search_workspace","args":{"query":"关键词"}}
\`\`\`

tool 只能取：search_workspace（args: query）/ list_pages（无参数）/ get_page_content（args: page）/
list_database_fields（args: database）/ query_database（args: database, 可选 limit）。

注意：文档第一行是标题（不能改动），第二行是分割线；不要试图改动这两行。
content 用 Markdown 语法书写；summary 是一句话中文说明，会展示给用户。
每个动作各占一个代码块，可以输出多个；动作代码块必须放在整条回复的最后，最后一个块之后不要再写内容。
旧的平铺写法 {"op":...,"content":...}（不带 tool/args）仍然允许，视为 apply_edit。
不要在正文中举例或解释这些标记。
如果用户只是在提问、不需要改动知识库，就不要输出动作块。
始终使用与用户提问相同的语言作答。`;

/** 当前没有可编辑文档时的协议说明：动作块照常，只是没有「当前页」可改 */
const NO_DOC_NOTE = `【当前文档】没有打开中的可编辑文档。
因此不要使用 apply_edit（除非带上 view_id 指向某个已存在的页面）；
建页、改标题、往表格加行、检索都照常可用。`;

/** 没有打开文档时的 system prompt：协议照常下发（建页/改表/检索仍需要），只是编辑目标缺失 */
export const CHAT_ONLY_SYSTEM_PROMPT = `${PROTOCOL}\n${NO_DOC_NOTE}`;

/** 检索结果回灌时给模型的说明前缀 */
export function retrievalResultMessage(results: { tool: string; result: string }[]): string {
  const body = results.map((r) => `### ${r.tool}\n${r.result}`).join("\n\n");
  return `【检索结果】以下是前端执行你的检索请求得到的真实数据，请据此继续完成用户的任务：\n${body}`;
}

/** 组装 system prompt：动作协议 + 当前文档上下文 */
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

function validateAnchor(value: unknown): AiEditAnchor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const anchor: AiEditAnchor = {};
  if (typeof o.heading === "string" && o.heading.trim()) anchor.heading = o.heading.trim();
  if (typeof o.text === "string" && o.text.trim()) anchor.text = o.text;
  return Object.keys(anchor).length > 0 ? anchor : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 校验并规整单个动作；不合法返回 null */
export function validateCall(value: unknown): AiCall | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  // 旧平铺格式：{"op":...,"summary":...,"content":...} → apply_edit
  if (typeof o.op === "string" && !("tool" in o)) {
    const call = validateCall({ tool: "apply_edit", args: o });
    return call;
  }
  const tool = o.tool;
  const args = (typeof o.args === "object" && o.args !== null ? o.args : {}) as Record<string, unknown>;
  switch (tool) {
    case "apply_edit": {
      const op = args.op;
      if (typeof op !== "string" || !AI_EDIT_OPS.includes(op as AiEditOp)) return null;
      const content = optionalString(args.content);
      // 除纯改名类操作外，content 必填
      if (!content) return null;
      const anchor = validateAnchor(args.anchor);
      const viewId = optionalString(args.view_id);
      return {
        tool: "apply_edit",
        args: {
          op: op as AiEditOp,
          summary: typeof args.summary === "string" ? args.summary.trim() : "",
          content,
          ...(anchor ? { anchor } : {}),
          ...(viewId ? { view_id: viewId } : {}),
        },
      };
    }
    case "create_page": {
      const title = optionalString(args.title);
      if (!title) return null;
      const content = optionalString(args.content);
      const parent = optionalString(args.parent_page);
      return {
        tool: "create_page",
        args: { title, ...(content ? { content } : {}), ...(parent ? { parent_page: parent } : {}) },
      };
    }
    case "set_page_title": {
      const page = optionalString(args.page);
      const title = optionalString(args.title);
      if (!page || !title) return null;
      return { tool: "set_page_title", args: { page, title } };
    }
    case "add_database_row": {
      const database = optionalString(args.database);
      if (!database) return null;
      const cells =
        typeof args.cells === "object" && args.cells !== null ? (args.cells as Record<string, unknown>) : undefined;
      return { tool: "add_database_row", args: { database, ...(cells ? { cells } : {}) } };
    }
    default:
      if (RETRIEVAL_TOOLS.includes(tool as RetrievalKind)) {
        return { tool: tool as RetrievalKind, args };
      }
      return null;
  }
}

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
