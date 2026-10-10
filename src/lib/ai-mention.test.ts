import { describe, expect, it } from "vitest";
import { detectMentionQuery, mentionScore, parseMentions } from "./ai-mention";

const CANDIDATES = [
  { id: "a", name: "周报" },
  { id: "b", name: "周报归档" },
  { id: "c", name: "会议记录" },
];

describe("parseMentions", () => {
  it("识别 @文件名 并返回文档引用", () => {
    expect(parseMentions("帮我改写 @周报 的内容", CANDIDATES)).toEqual([{ id: "a", name: "周报" }]);
  });

  it("没有 @ 时不返回引用", () => {
    expect(parseMentions("帮我改写周报的内容", CANDIDATES)).toEqual([]);
  });

  it("长名字优先，避免短名字误配到长名字内部", () => {
    expect(parseMentions("@周报归档 请总结", CANDIDATES)).toEqual([{ id: "b", name: "周报归档" }]);
  });

  it("同一文档多次引用只保留一次", () => {
    expect(parseMentions("@周报 和 @周报 对比", CANDIDATES)).toEqual([{ id: "a", name: "周报" }]);
  });

  it("可同时引用多个文档", () => {
    expect(parseMentions("@周报 与 @会议记录", CANDIDATES)).toEqual([
      { id: "a", name: "周报" },
      { id: "c", name: "会议记录" },
    ]);
  });

  it("@ 不在行首/空白之后（如邮箱）不误判", () => {
    expect(parseMentions("联系 a@周报.com", CANDIDATES)).toEqual([]);
  });

  it("名字为空的候选被忽略", () => {
    expect(parseMentions("@x", [{ id: "z", name: "  " }])).toEqual([]);
  });
});

describe("detectMentionQuery", () => {
  it("行首 @ 触发引用输入", () => {
    expect(detectMentionQuery("@周", 2)).toEqual({ start: 0, query: "周" });
  });

  it("空白之后的 @ 触发引用输入", () => {
    expect(detectMentionQuery("看看 @周报", 6)).toEqual({ start: 3, query: "周报" });
  });

  it("查询词含空白后不再触发", () => {
    expect(detectMentionQuery("看看 @周报 今天", 9)).toBeNull();
  });

  it("没有 @ 时不触发", () => {
    expect(detectMentionQuery("普通文本", 4)).toBeNull();
  });

  it("@ 前是普通字符（如邮箱）不触发", () => {
    expect(detectMentionQuery("a@b", 3)).toBeNull();
  });
});

describe("mentionScore", () => {
  it("空查询全部匹配（返回 0 分为基准）", () => {
    expect(mentionScore("周报", "")).toBe(0);
    expect(mentionScore("周报", "  ")).toBe(0);
  });

  it("前缀命中分数最高，连续包含次之且越靠前越好", () => {
    const prefix = mentionScore("周报归档", "周报")!;
    const containsEarly = mentionScore("本周报归档", "周报")!;
    const containsLate = mentionScore("今日本周报", "周报")!;
    expect(prefix).toBeGreaterThan(containsEarly);
    expect(containsEarly).toBeGreaterThan(containsLate);
  });

  it("跳字子序列可匹配，乱序不匹配", () => {
    expect(mentionScore("会议记录", "会录")).not.toBeNull();
    expect(mentionScore("会议记录", "录会")).toBeNull();
  });

  it("英文大小写不敏感", () => {
    expect(mentionScore("Meeting Notes", "mn")).not.toBeNull();
    expect(mentionScore("Meeting Notes", "MN")).toEqual(mentionScore("Meeting Notes", "mn"));
  });

  it("连续命中片段比分散命中得分高", () => {
    expect(mentionScore("周报和周会记录", "周报")!).toBeGreaterThan(mentionScore("周记与报道计划", "周报")!);
  });

  it("完全不含查询字符则不匹配", () => {
    expect(mentionScore("周报", "月报")).toBeNull();
  });
});
