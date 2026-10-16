import { describe, expect, it } from "vitest";
import { countWords, readingMinutes } from "./word-count";

describe("countWords", () => {
  it("整句中文按字计，不按空格分词", () => {
    expect(countWords("今天讨论了两个方案")).toEqual({ cjk: 9, latin: 0, total: 9 });
  });

  it("英文按词计，撇号与连字符不拆开一个词", () => {
    expect(countWords("The quick brown fox").total).toBe(4);
    expect(countWords("don't well-known").total).toBe(2);
    expect(countWords("2026-10-15 是 deadline").total).toBe(3); // 日期算 1 个词，别被连字符拆成三段
  });

  it("中英混排两边都算，且汉字充当词边界", () => {
    expect(countWords("使用 React 渲染")).toEqual({ cjk: 4, latin: 1, total: 5 });
    expect(countWords("word汉字word")).toEqual({ cjk: 2, latin: 2, total: 4 });
  });

  it("假名与韩文按字计", () => {
    expect(countWords("カタカナ").cjk).toBe(4);
    expect(countWords("한국어").cjk).toBe(3);
  });

  it("标点、emoji、空白都不算词", () => {
    expect(countWords("!!! ??? ...").total).toBe(0);
    expect(countWords("🎉🎉 ok").total).toBe(1);
    expect(countWords("你好，世界。").cjk).toBe(4); // 全角逗号句号不算字
  });

  it("空文本是零", () => {
    expect(countWords("")).toEqual({ cjk: 0, latin: 0, total: 0 });
  });
});

describe("readingMinutes", () => {
  it("没内容不显示时长", () => {
    expect(readingMinutes(countWords(""))).toBe(0);
  });

  it("有内容至少一分钟，向上取整", () => {
    expect(readingMinutes(countWords("你好"))).toBe(1);
    expect(readingMinutes(countWords("a".repeat(0) + "x ".repeat(300)))).toBe(2);
  });

  it("两套速度分开折算再相加", () => {
    // 600 字（2 分钟）+ 440 词（2 分钟）= 4 分钟
    const cjkText = "字".repeat(600);
    const both = `${cjkText} ${"word ".repeat(440)}`;
    expect(readingMinutes(countWords(cjkText))).toBe(2);
    expect(readingMinutes(countWords(both))).toBe(4);
  });
});
