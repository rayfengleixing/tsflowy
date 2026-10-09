import { describe, expect, it } from "vitest";
import { EDIT_BLOCK_TAG, buildEditSystemPrompt, extractEdit, hideEditBlock } from "./ai-edit";

/** 拼一个编辑指令代码块 */
const block = (json: string) => "```" + EDIT_BLOCK_TAG + "\n" + json + "\n```";

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
    expect(r.edit).toEqual({ op: "replace_selection", summary: "改写了第二段", content: "## 新标题" });
    expect(r.display).toBe("已按要求改写。");
  });

  it("summary 缺失时回落为空串，由界面兜底文案", () => {
    const r = extractEdit(block('{"op":"append_to_document","content":"结尾"}'));
    expect(r.edit).toEqual({ op: "append_to_document", summary: "", content: "结尾" });
  });

  it("JSON 不合法时剥掉坏块并报告 malformed，正文仍保留", () => {
    const text = `正文说明。\n\n${block("{不是 json}")}`;
    const r = extractEdit(text);
    expect(r.edit).toBeNull();
    expect(r.malformed).toBe(true);
    expect(r.display).toBe("正文说明。");
  });

  it("正文里出现多个指令块时取最后一个（模型可能先复述协议）", () => {
    const first = block('{"op":"insert_at_cursor","summary":"错的位置","content":"不该用这个"}');
    const last = block('{"op":"append_to_document","summary":"对的位置","content":"用这个"}');
    const r = extractEdit(`开头\n${first}\n中间说明\n${last}\n`);
    expect(r.edit).toEqual({ op: "append_to_document", summary: "对的位置", content: "用这个" });
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
    expect(r.edit?.op).toBe("insert_at_cursor");
    expect(r.edit?.content).toBe("插入");
    expect(r.display).toBe("开头");
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
});

describe("buildEditSystemPrompt", () => {
  it("带上标题、选区与文档全文", () => {
    const p = buildEditSystemPrompt({ title: "周报", selection: "选中内容", pageText: "全文内容" });
    expect(p).toContain("周报");
    expect(p).toContain("选中内容");
    expect(p).toContain("全文内容");
    expect(p).toContain(EDIT_BLOCK_TAG);
  });

  it("没有选区时提示改动目标，空标题有兜底", () => {
    const p = buildEditSystemPrompt({ title: "", selection: "", pageText: "" });
    expect(p).toContain("没有选中");
    expect(p).toContain("（未命名）");
    expect(p).toContain("（空文档）");
  });
});
