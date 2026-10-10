import { describe, expect, it } from "vitest";
import { estimateTokens, tailTokens } from "./ai-tokens";

describe("estimateTokens", () => {
  it("空文本为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("中文按 1 字 ≈ 1 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("拉丁文本按约 4 字符 ≈ 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    // 不足 4 个字符也计 1
    expect(estimateTokens("ab")).toBe(1);
  });

  it("中英混排分别计数", () => {
    // 2 个汉字 + 8 个拉丁字符 → 2 + 2 = 4
    expect(estimateTokens("你好abcdefgh")).toBe(4);
  });

  it("全角标点按宽字符计", () => {
    expect(estimateTokens("，。")).toBe(2);
  });

  it("估算不随长度爆炸：万字中文约万 token", () => {
    expect(estimateTokens("测".repeat(10000))).toBe(10000);
  });
});

describe("tailTokens", () => {
  it("预算足够时原样返回", () => {
    expect(tailTokens("短文本", 100)).toBe("短文本");
    expect(tailTokens("", 10)).toBe("");
  });

  it("超预算时保留尾部", () => {
    const text = "一二三四五六七八九十";
    const tail = tailTokens(text, 3);
    expect(tail.length).toBeLessThan(text.length);
    expect(text.endsWith(tail)).toBe(true);
    expect(estimateTokens(tail)).toBeLessThanOrEqual(3);
  });

  it("至少保留一个字符", () => {
    expect(tailTokens("很长的中文内容啊啊啊啊", 0)).toBe("啊");
  });

  it("拉丁文本按 4 字符权重收尾", () => {
    const tail = tailTokens("abcdefghijklmnopqrstuvwxyz", 3);
    // 3 token ≈ 12 字符
    expect(tail.length).toBeLessThanOrEqual(12);
    expect("abcdefghijklmnopqrstuvwxyz".endsWith(tail)).toBe(true);
  });
});
