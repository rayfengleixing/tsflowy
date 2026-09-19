import { describe, expect, it } from "vitest";
import { evalFormula } from "./database-formula";

describe("evalFormula", () => {
  const ref = (n: string) => ({ a: 2, b: 3, empty: null })[n] ?? null;

  it("基础四则与优先级", () => {
    expect(evalFormula("1 + 2 * 3", ref)).toBe(7);
    expect(evalFormula("(1 + 2) * 3", ref)).toBe(9);
    expect(evalFormula("10 / 4", ref)).toBe(2.5);
  });

  it("字段引用", () => {
    expect(evalFormula("{a} * {b}", ref)).toBe(6);
    expect(evalFormula("-{a} + 10", ref)).toBe(8);
  });

  it("引用为空 → null（不按 0 算）", () => {
    expect(evalFormula("{empty} * 2", ref)).toBeNull();
    expect(evalFormula("{missing} + 1", ref)).toBeNull();
  });

  it("非法表达式 → null", () => {
    expect(evalFormula("", ref)).toBeNull();
    expect(evalFormula("1 2", ref)).toBeNull();
    expect(evalFormula("{a", ref)).toBeNull();
    expect(evalFormula("a + 1", ref)).toBeNull();
    expect(evalFormula("(1 + 2", ref)).toBeNull();
  });

  it("除零 → null", () => {
    expect(evalFormula("1 / 0", ref)).toBeNull();
    expect(evalFormula("5 / (3 - 3)", ref)).toBeNull();
  });
});
