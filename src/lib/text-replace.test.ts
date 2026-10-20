import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";

import { replaceInDocContent, replaceOccurrences } from "./text-replace";

// 全局替换的语义闸门都在这里：只改单个 text 叶子内的字面串、mark 原样保留、
// 页面标题（首个 heading 块）永不动、改不动的命中必须如实计数而不是静默跳过。

const t = (value: string, marks?: { type: string }[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

describe("replaceOccurrences", () => {
  it("默认忽略大小写：一处字符串里的全部命中都改掉并给出处数", () => {
    expect(replaceOccurrences("API 与 api 都是 API", "API", "接口")).toEqual({
      text: "接口 与 接口 都是 接口",
      count: 3,
    });
  });

  it("区分大小写时只改字面一致的", () => {
    expect(replaceOccurrences("API api", "API", "接口", { caseSensitive: true })).toEqual({
      text: "接口 api",
      count: 1,
    });
  });

  it("全词只约束拉丁词：查 the 不命中 there，中文不受影响", () => {
    expect(replaceOccurrences("the there", "the", "一个", { wholeWord: true })).toEqual({
      text: "一个 there",
      count: 1,
    });
    expect(replaceOccurrences("这是一个测试文本", "测试", "校验", { wholeWord: true }).count).toBe(1);
  });

  it("查询词为空一律原样返回（否则等于在每个字符间插入替换串）", () => {
    expect(replaceOccurrences("abc", "", "X")).toEqual({ text: "abc", count: 0 });
  });

  it("替换串为空即删除命中", () => {
    expect(replaceOccurrences("a-b-c", "-", "")).toEqual({ text: "abc", count: 2 });
  });
});

describe("replaceInDocContent", () => {
  it("改内联段里的全部命中，mark 一个都不丢", () => {
    const content = [p(t("旧名 与 ", [{ type: "bold" }]), t("旧名结尾"))];
    const result = replaceInDocContent(content, "旧名", "新名");
    expect(result.content).toEqual([p(t("新名 与 ", [{ type: "bold" }]), t("新名结尾"))]);
    expect(result.counts).toEqual({ replaced: 2, crossFormat: 0, protectedTitle: 0 });
  });

  it("首个标题块是页面标题：计数但不改写", () => {
    const content = [{ type: "heading", attrs: { level: 1 }, content: [t("旧名指南")] }, p(t("正文里的旧名"))];
    const result = replaceInDocContent(content, "旧名", "新名");
    expect(result.content[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [t("旧名指南")] });
    expect(result.counts).toEqual({ replaced: 1, crossFormat: 0, protectedTitle: 1 });
  });

  it("命中横跨内联段时不动结构，如实记为跨格式", () => {
    const content = [p(t("前端", [{ type: "bold" }]), t("框架"))];
    const result = replaceInDocContent(content, "前端框架", "后端");
    expect(result.content[0]).toBe(content[0]);
    expect(result.counts).toEqual({ replaced: 0, crossFormat: 1, protectedTitle: 0 });
  });

  it("替换成空串时不留空 text 叶子（ProseMirror 会拒绝）", () => {
    const result = replaceInDocContent([p(t("only"))], "only", "");
    expect(JSON.stringify(result.content)).toBe('[{"type":"paragraph"}]');
    expect(result.counts.replaced).toBe(1);
  });

  it("嵌套结构（列表项、表格单元格）里的命中同样改到", () => {
    const content = [
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("旧名 一"))] }] },
      {
        type: "table",
        content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(t("旧名 二"))] }] }],
      },
    ];
    const result = replaceInDocContent(content, "旧名", "新名");
    expect(JSON.stringify(result.content)).toContain("新名 一");
    expect(JSON.stringify(result.content)).toContain("新名 二");
    expect(result.counts.replaced).toBe(2);
  });

  it("没有命中时逐块原样带回，不重建任何节点", () => {
    const content = [p(t("正文"))];
    const result = replaceInDocContent(content, "旧名", "新名");
    expect(result.content[0]).toBe(content[0]);
    expect(result.counts.replaced).toBe(0);
  });
});
