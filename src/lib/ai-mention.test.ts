import { describe, expect, it } from "vitest";
import { detectMentionQuery, parseMentions } from "./ai-mention";

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
