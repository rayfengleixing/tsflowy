import { describe, expect, it } from "vitest";
import * as aiEditModule from "./index";
import {
  buildEditSystemPrompt,
  buildNoContextSystemPrompt,
  CALL_BLOCK_TAG,
  CHAT_ONLY_SYSTEM_PROMPT,
  CTX_SCOPE_PAGE_ONLY_NOTE,
  EDIT_BLOCK_TAG,
  extractCalls,
  extractEdit,
  hideEditBlock,
  RETRIEVAL_BLOCKED_BY_SCOPE_NOTE,
  RETRIEVAL_TOOLS,
  retrievalResultMessage,
} from "./index";
import type {
  AiCall,
  AiEditAnchor,
  AiEditContext,
  AiEditOp,
  AiWriteCall,
  ExtractCallsResult,
  RetrievalCall,
  RetrievalKind,
  WriteTool,
} from "./index";

/** 拼一个编辑指令代码块 */
const block = (json: string) => "```" + EDIT_BLOCK_TAG + "\n" + json + "\n```";
/** 拼一个只读检索请求块 */
const call = (json: string) => "```" + CALL_BLOCK_TAG + "\n" + json + "\n```";

describe("extractEdit", () => {
  it("没有指令块时原样返回", () => {
    const r = extractEdit("你好，这是普通回答。");
    expect(r.edit).toBeNull();
    expect(r.display).toBe("你好，这是普通回答。");
  });

  it("解析编辑指令并移除指令块", () => {
    const text = `已按要求改写。\n\n${block(
      '{"op":"replace_selection","summary":"改写了第二段","content":"## 新标题"}',
    )}`;
    const r = extractEdit(text);
    expect(r.edit).toEqual({
      tool: "apply_edit",
      args: { op: "replace_selection", summary: "改写了第二段", content: "## 新标题" },
    });
    expect(r.display).toBe("已按要求改写。");
  });

  it("summary 缺失时回落为空串，由界面兜底文案", () => {
    const r = extractEdit(block('{"op":"append_to_document","content":"结尾"}'));
    expect(r.edit).toEqual({ tool: "apply_edit", args: { op: "append_to_document", summary: "", content: "结尾" } });
  });

  it("JSON 不合法时剥掉坏块并报告 malformed，正文仍保留", () => {
    const text = `正文说明。\n\n${block("{不是 json}")}`;
    const r = extractEdit(text);
    expect(r.edit).toBeNull();
    expect(r.malformed).toBe(true);
    expect(r.display).toBe("正文说明。");
  });

  it("正文里出现多个指令块时，extractEdit 取最后一个 apply_edit", () => {
    const first = block('{"op":"insert_at_cursor","summary":"错的位置","content":"不该用这个"}');
    const last = block('{"op":"append_to_document","summary":"对的位置","content":"用这个"}');
    const r = extractEdit(`开头\n${first}\n中间说明\n${last}\n`);
    expect(r.edit).toEqual({
      tool: "apply_edit",
      args: { op: "append_to_document", summary: "对的位置", content: "用这个" },
    });
    expect(r.display).toContain("开头");
    expect(r.display).toContain("中间说明");
    expect(r.display).not.toContain("不该用这个");
  });

  it("正常回答不误报 malformed", () => {
    expect(extractEdit("普通回答，没有指令块。").malformed).toBe(false);
  });

  it("op 不在允许范围内时拒绝（含被结构锁定挡掉的整篇重写）", () => {
    expect(extractEdit(block('{"op":"replace_document","content":"x"}')).edit).toBeNull();
    expect(extractEdit(block('{"op":"hack","content":"x"}')).edit).toBeNull();
  });

  it("content 为空时拒绝", () => {
    expect(extractEdit(block('{"op":"replace_selection","content":"   "}')).edit).toBeNull();
  });

  it("围栏未闭合也能提取（流式被截断）", () => {
    const text = `开头\n${"```" + EDIT_BLOCK_TAG}\n{"op":"insert_at_cursor","content":"插入"}`;
    const r = extractEdit(text);
    expect(r.edit).toEqual({ tool: "apply_edit", args: { op: "insert_at_cursor", summary: "", content: "插入" } });
    expect(r.display).toBe("开头");
  });
});

describe("extractCalls", () => {
  it("多个动作块各成一个动作，顺序保留", () => {
    const text = [
      "已处理。",
      block('{"tool":"apply_edit","args":{"op":"append_to_document","summary":"补一段","content":"追加"}}'),
      block('{"tool":"set_page_title","args":{"page":"周报","title":"第 41 周周报"}}'),
    ].join("\n\n");
    const r = extractCalls(text);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toEqual({
      tool: "apply_edit",
      args: { op: "append_to_document", summary: "补一段", content: "追加" },
    });
    expect(r.calls[1]).toEqual({ tool: "set_page_title", args: { page: "周报", title: "第 41 周周报" } });
    expect(r.display).toBe("已处理。");
    expect(r.malformed).toBe(false);
  });

  it("检索请求块解析为只读动作", () => {
    const r = extractCalls(`先查一下。\n\n${call('{"tool":"search_workspace","args":{"query":"需求评审"}}')}`);
    expect(r.calls).toEqual([{ tool: "search_workspace", args: { query: "需求评审" } }]);
    expect(r.display).toBe("先查一下。");
  });

  it("未知 tool 与缺必填参数的动作都算 malformed", () => {
    expect(extractCalls(block('{"tool":"drop_table","args":{}}')).malformed).toBe(true);
    expect(extractCalls(block('{"tool":"create_page","args":{}}')).malformed).toBe(true);
    expect(extractCalls(block('{"tool":"set_page_title","args":{"page":"a"}}')).calls).toHaveLength(0);
  });

  it("改/删表行：没有 row 引用一律拒，猜行会改到别人的数据", () => {
    expect(
      extractCalls(block('{"tool":"update_database_row","args":{"database":"任务","cells":{"状态":"完成"}}}')).calls,
    ).toHaveLength(0);
    expect(extractCalls(block('{"tool":"delete_database_row","args":{"database":"任务"}}')).malformed).toBe(true);
    const r = extractCalls(
      block('{"tool":"update_database_row","args":{"database":"任务","row":"r1","cells":{"状态":"完成"}}}'),
    );
    expect(r.calls[0]).toEqual({
      tool: "update_database_row",
      args: { database: "任务", row: "r1", cells: { 状态: "完成" } },
    });
  });

  it("apply_edit 的 anchor 与 view_id 原样带出，空白锚点丢弃", () => {
    const r = extractCalls(
      block(
        '{"tool":"apply_edit","args":{"op":"replace_text","content":"新词","anchor":{"heading":"  ","text":"旧词"},"view_id":"v1"}}',
      ),
    );
    expect(r.calls[0]).toEqual({
      tool: "apply_edit",
      args: { op: "replace_text", summary: "", content: "新词", anchor: { text: "旧词" }, view_id: "v1" },
    });
  });

  it("混合正文与多个块时只留下块之间的文字", () => {
    const text = `第一段\n\n${call('{"tool":"list_pages","args":{}}')}\n\n第二段\n\n${block(
      '{"op":"append_to_document","content":"x"}',
    )}\n\n第三段`;
    const r = extractCalls(text);
    expect(r.display).toBe("第一段\n\n第二段\n\n第三段");
    expect(r.calls).toHaveLength(2);
  });

  it("空块（流式只写到标记）报告 malformed 且不吞正文", () => {
    const r = extractCalls(`答案\n\n${"```" + EDIT_BLOCK_TAG}`);
    expect(r.malformed).toBe(true);
    expect(r.calls).toHaveLength(0);
    expect(r.display).toBe("答案");
  });
});

describe("hideEditBlock", () => {
  it("没有指令块时原样返回", () => {
    expect(hideEditBlock("普通文本")).toBe("普通文本");
  });

  it("流式过程中把半个指令块藏起来", () => {
    const soFar = `说明文字\n${"```" + EDIT_BLOCK_TAG}\n{"op":"repl`;
    expect(hideEditBlock(soFar)).toBe("说明文字\n");
  });

  it("检索请求块同样藏起来", () => {
    const soFar = `说明文字\n${"```" + CALL_BLOCK_TAG}\n{"tool":"search_`;
    expect(hideEditBlock(soFar)).toBe("说明文字\n");
  });
});

describe("buildEditSystemPrompt", () => {
  it("带上标题、选区与文档全文", () => {
    const p = buildEditSystemPrompt({ title: "周报", selection: "选中内容", pageText: "全文内容" });
    expect(p).toContain("周报");
    expect(p).toContain("选中内容");
    expect(p).toContain("全文内容");
    // 断言整行开栏：协议正文若把标记接成硬编码假名（哪怕是真标记的前缀/扩展），模型就会输出前端不认的块
    expect(p).toContain("```" + EDIT_BLOCK_TAG + "\n");
    expect(p).toContain("```" + CALL_BLOCK_TAG + "\n");
  });

  it("没有选区时提示改动目标，空标题有兜底", () => {
    const p = buildEditSystemPrompt({ title: "", selection: "", pageText: "" });
    expect(p).toContain("没有选中");
    expect(p).toContain("（未命名）");
    expect(p).toContain("（空文档）");
  });
});

describe("protocol 层的其余导出", () => {
  it("没有可编辑文档时协议照常下发，只是没有当前页", () => {
    expect(CHAT_ONLY_SYSTEM_PROMPT).toContain("```" + EDIT_BLOCK_TAG + "\n");
    expect(CHAT_ONLY_SYSTEM_PROMPT).toContain("没有打开中的可编辑文档");
    expect(CHAT_ONLY_SYSTEM_PROMPT).not.toContain("标题：");
  });

  it("关闭上下文时按有没有可编辑文档换说明段", () => {
    const off = buildNoContextSystemPrompt(true);
    expect(off).toContain("用户已关闭当前文档上下文");
    expect(off).not.toContain("没有打开中的可编辑文档");
    const none = buildNoContextSystemPrompt(false);
    expect(none).toContain("没有打开中的可编辑文档");
    expect(none).not.toContain("用户已关闭当前文档上下文");
  });

  it("检索结果回灌带上前端执行出的真实数据", () => {
    const msg = retrievalResultMessage([
      { tool: "search_workspace", result: "命中 2 条" },
      { tool: "list_pages", result: "首页" },
    ]);
    expect(msg).toContain("【检索结果】");
    expect(msg).toContain("### search_workspace\n命中 2 条");
    expect(msg).toContain("### list_pages\n首页");
  });

  it("「仅本页」的两段说明点名全部检索工具", () => {
    for (const name of RETRIEVAL_TOOLS) expect(CTX_SCOPE_PAGE_ONLY_NOTE).toContain(name);
    expect(RETRIEVAL_BLOCKED_BY_SCOPE_NOTE).toContain("仅本页");
  });
});

describe("ai-edit 的对外符号面", () => {
  // 拆成目录模块后 index.ts 手写 re-export：漏一行且当下没人用那个符号，tsc 也不会报
  const VALUE_EXPORTS = [
    "AI_EDIT_OPS",
    "CALL_BLOCK_TAG",
    "CHAT_ONLY_SYSTEM_PROMPT",
    "CTX_SCOPE_PAGE_ONLY_NOTE",
    "EDIT_BLOCK_TAG",
    "RETRIEVAL_BLOCKED_BY_SCOPE_NOTE",
    "RETRIEVAL_TOOLS",
    "WRITE_TOOLS",
    "buildEditSystemPrompt",
    "buildNoContextSystemPrompt",
    "extractCalls",
    "extractEdit",
    "hideEditBlock",
    "retrievalResultMessage",
    "validateCall",
  ];

  it("运行时的 15 个值导出一个不少（类型导出由下面的编译期引用验）", () => {
    expect(Object.keys(aiEditModule).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it("九个类型导出可经 index 路径引用（少一行 export type 这里就编不过）", () => {
    const surface: {
      op: AiEditOp;
      anchor: AiEditAnchor;
      call: AiCall;
      kind: RetrievalKind;
      retrieval: RetrievalCall;
      write: WriteTool;
      writeCall: AiWriteCall;
      ctx: AiEditContext;
      extracted: ExtractCallsResult;
    } = {
      op: "replace_selection",
      anchor: { heading: "## 背景" },
      call: { tool: "set_page_title", args: { page: "周报", title: "第 41 周周报" } },
      kind: "list_pages",
      retrieval: { tool: "list_pages", args: {} },
      write: "apply_edit",
      writeCall: { tool: "create_page", args: { title: "新页" } },
      ctx: { title: "", selection: "", pageText: "" },
      extracted: extractCalls("普通回答"),
    };
    expect(Object.keys(surface)).toHaveLength(9);
  });
});
