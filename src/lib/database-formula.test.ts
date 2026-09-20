import { describe, expect, it } from "vitest";
import { evalFormula, renameFormulaRef } from "./database-formula";

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

describe("renameFormulaRef", () => {
  it("只改写命中的引用，其余原样保留", () => {
    expect(renameFormulaRef("{价格} * {数量}", "价格", "单价")).toBe("{单价} * {数量}");
    expect(renameFormulaRef("{价格} + {价格}", "价格", "单价")).toBe("{单价} + {单价}");
    expect(renameFormulaRef("{数量} + 1", "价格", "单价")).toBe("{数量} + 1");
  });

  it("名字包含空格/运算符时按引用整体匹配", () => {
    expect(renameFormulaRef("{ 价格 } * 2", "价格", "单价")).toBe("{单价} * 2");
    expect(renameFormulaRef("{a+b} + 1", "a+b", "c")).toBe("{c} + 1");
    expect(renameFormulaRef("{a} + 1", "a + 1", "c")).toBe("{a} + 1");
  });

  it("引用名只是子串时不被误改", () => {
    expect(renameFormulaRef("{价格} + {价格上限}", "价格", "单价")).toBe("{单价} + {价格上限}");
  });

  it("未闭合的引用不改写", () => {
    expect(renameFormulaRef("{价格", "价格", "单价")).toBe("{价格");
  });
});
