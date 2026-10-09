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

describe("evalFormula 比较 / 逻辑 / 字符串", () => {
  const ref = (n: string) => ({ a: 2, b: 3, name: "x", date: "2026-10-08", empty: null })[n] ?? null;

  it("比较运算返回布尔", () => {
    expect(evalFormula("{a} < {b}", ref)).toBe(true);
    expect(evalFormula("{a} >= 2", ref)).toBe(true);
    expect(evalFormula("{a} = {b}", ref)).toBe(false);
    expect(evalFormula("{a} != {b}", ref)).toBe(true);
    expect(evalFormula("{a} <> {b}", ref)).toBe(true);
  });

  it("字符串按字典序比较", () => {
    expect(evalFormula('"apple" < "banana"', ref)).toBe(true);
    expect(evalFormula('{name} = "x"', ref)).toBe(true);
  });

  it("AND / OR / NOT", () => {
    expect(evalFormula("{a} < {b} AND {a} = 2", ref)).toBe(true);
    expect(evalFormula("{a} > {b} OR {a} = 2", ref)).toBe(true);
    expect(evalFormula("NOT ({a} > {b})", ref)).toBe(true);
  });

  it("布尔字面量", () => {
    expect(evalFormula("true", ref)).toBe(true);
    expect(evalFormula("TRUE AND FALSE", ref)).toBe(false);
  });
});

describe("evalFormula 函数", () => {
  const ref = (n: string) => ({ a: 2, b: 3, c: 10, name: "x", date: "2026-10-08", empty: null })[n] ?? null;

  it("IF 惰性求值（只算命中的分支，除零不污染）", () => {
    expect(evalFormula("IF({a} < {b}, 100, 0)", ref)).toBe(100);
    expect(evalFormula("IF({a} > {b}, 100, 0)", ref)).toBe(0);
    expect(evalFormula("IF({a} > {b}, 1/0, 42)", ref)).toBe(42);
    expect(evalFormula("IF({a} < {b}, 42)", ref)).toBe(42);
  });

  it("SUM / AVG / MIN / MAX 忽略空值", () => {
    expect(evalFormula("SUM({a}, {b}, {empty})", ref)).toBe(5);
    expect(evalFormula("AVG({a}, {b})", ref)).toBe(2.5);
    expect(evalFormula("MIN({a}, {b}, {c})", ref)).toBe(2);
    expect(evalFormula("MAX({a}, {b}, {c})", ref)).toBe(10);
    expect(evalFormula("SUM({empty})", ref)).toBeNull();
  });

  it("ROUND / ABS", () => {
    expect(evalFormula("ROUND(2.567, 2)", ref)).toBe(2.57);
    expect(evalFormula("ROUND(2.5)", ref)).toBe(3);
    expect(evalFormula("ABS(0 - {c})", ref)).toBe(10);
  });

  it("CONCAT 拼接文本", () => {
    expect(evalFormula('CONCAT("A", {name}, "B")', ref)).toBe("AxB");
    expect(evalFormula('CONCAT({a}, "-", {b})', ref)).toBe("2-3");
  });

  it("日期函数", () => {
    expect(evalFormula("YEAR({date})", ref)).toBe(2026);
    expect(evalFormula("MONTH({date})", ref)).toBe(10);
    expect(evalFormula("DAY({date})", ref)).toBe(8);
    expect(evalFormula("YEAR({a})", ref)).toBeNull();
    expect(evalFormula("TODAY()", ref)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("未知函数 / 参数不足 → null", () => {
    expect(evalFormula("FOO(1)", ref)).toBeNull();
    expect(evalFormula("IF(1)", ref)).toBeNull();
    expect(evalFormula("ROUND()", ref)).toBeNull();
  });

  it("嵌套表达式与函数组合", () => {
    expect(evalFormula("IF(SUM({a}, {b}) > 4, ROUND({c} / 3, 1), 0)", ref)).toBe(3.3);
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
