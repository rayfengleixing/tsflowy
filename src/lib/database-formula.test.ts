import { describe, expect, it } from "vitest";
import type { DatabaseField } from "@/types/database";
import { computeFormula, computeRowFormulas, evalFormula, FORMULA_CYCLE, renameFormulaRef } from "./database-formula";

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

describe("computeRowFormulas 依赖图求值", () => {
  const mk = (id: string, name: string, formula?: string): DatabaseField => ({
    id,
    database_view_id: "v1",
    name,
    field_type: formula !== undefined ? "formula" : "number",
    options: formula !== undefined ? JSON.stringify({ kind: "formula", formula }) : JSON.stringify({ kind: "none" }),
    width: 120,
    is_hidden: 0,
    position: 0,
  });

  it("公式引用公式：取对方的计算值而不是空存储格", () => {
    const fields = [mk("qty", "数量"), mk("total", "金额", "{数量} * 2"), mk("shown", "展示", "{金额} + 1")];
    const values = computeRowFormulas({ qty: 20 }, fields);
    expect(values.get("total")).toBe(40);
    expect(values.get("shown")).toBe(41);
  });

  it("互相引用 → 环成员标记 #CYCLE，不递归不死循环", () => {
    const fields = [mk("a", "A", "{B}"), mk("b", "B", "{A}")];
    const values = computeRowFormulas({}, fields);
    expect(values.get("a")).toBe(FORMULA_CYCLE);
    expect(values.get("b")).toBe(FORMULA_CYCLE);
  });

  it("引用环成员（自己不在环里）：拿到 #CYCLE 文本按无效参与运算", () => {
    const fields = [mk("a", "A", "{B}"), mk("b", "B", "{A}"), mk("c", "C", "{A} + 1")];
    const values = computeRowFormulas({}, fields);
    expect(values.get("c")).toBeNull();
  });

  it("自引用保持旧行为：按无效（null），不标环", () => {
    const fields = [mk("s", "S", "{S} + 1")];
    expect(computeRowFormulas({}, fields).get("s")).toBeNull();
  });

  it("拓扑序与声明顺序无关", () => {
    const fields = [mk("shown", "展示", "{金额} * 10"), mk("total", "金额", "{数量} + 1"), mk("qty", "数量")];
    expect(computeRowFormulas({ qty: 4 }, fields).get("shown")).toBe(50);
  });

  it("computeFormula 走同一套依赖求值", () => {
    const fields = [mk("qty", "数量"), mk("total", "金额", "{数量} * 2"), mk("shown", "展示", "{金额} + 1")];
    expect(computeFormula(fields[2], { qty: 20 }, fields)).toBe(41);
  });
});
