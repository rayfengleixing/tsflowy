import { describe, expect, it } from "vitest";
import { pinyinInitials } from "./pinyin-initials";

describe("pinyinInitials", () => {
  it("中文转拼音首字母", () => {
    expect(pinyinInitials("标题")).toBe("BT");
    expect(pinyinInitials("文本")).toBe("WB");
    expect(pinyinInitials("数据库表")).toBe("SJKB");
    expect(pinyinInitials("数学公式")).toBe("SXGS");
  });

  it("数字/英文原样转大写", () => {
    expect(pinyinInitials("标题 1")).toBe("BT1");
    expect(pinyinInitials("Heading 2")).toBe("HEADING2");
  });

  it("任意常用标题都能出首字母（不再受手写映射表覆盖限制）", () => {
    expect(pinyinInitials("笔记整理")).toBe("BJZL");
    expect(pinyinInitials("产品需求文档")).toBe("CPXQWD");
  });

  it("生僻字出首字母，非汉字标点丢弃", () => {
    expect(pinyinInitials("饕餮")).toBe("TT");
    expect(pinyinInitials("笔记·整理")).toBe("BJZL");
  });

  it("混合文本", () => {
    expect(pinyinInitials("A标题")).toBe("ABT");
  });
});
