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

  it("未覆盖的字返回空串（不影响降级匹配）", () => {
    expect(pinyinInitials("饕餮")).toBe("");
  });

  it("混合文本", () => {
    expect(pinyinInitials("A标题")).toBe("ABT");
  });
});
