import { describe, expect, it } from "vitest";
import type { DatabaseField } from "@/types/database";
import {
  computeFormula,
  computeRowFormulas,
  evalFormula,
  FORMULA_CYCLE,
  referencedFieldNames,
  renameFormulaRef,
  validateFormula,
} from "./database-formula";

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
    expect(evalFormula("YEAR({name})", ref)).toBeNull();
    expect(evalFormula("YEAR({empty})", ref)).toBeNull();
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

describe("referencedFieldNames", () => {
  const mk = (
    id: string,
    name: string,
    type: DatabaseField["field_type"] = "number",
    formula?: string,
  ): DatabaseField => ({
    id,
    database_view_id: "v1",
    name,
    field_type: type,
    options: formula !== undefined ? JSON.stringify({ kind: "formula", formula }) : JSON.stringify({ kind: "none" }),
    width: 120,
    is_hidden: 0,
    position: 0,
  });

  it("收集全部公式引用到的字段名，供上层决定哪些列要先算出可视值", () => {
    const fields = [
      mk("qty", "数量"),
      mk("st", "状态", "single_select"),
      mk("total", "金额", "formula", "{数量} * 2"),
      mk("tag", "标签", "formula", "CONCAT({状态}, {金额})"),
    ];
    expect([...referencedFieldNames(fields)].sort()).toEqual(["数量", "状态", "金额"].sort());
  });

  it("空表达式与非法表达式不贡献引用", () => {
    const fields = [mk("a", "A", "formula", "   "), mk("b", "B", "formula", "{未闭合")];
    expect(referencedFieldNames(fields)).toEqual(new Set());
  });

  it("没有公式字段时返回空集合（计算列不必为公式额外取数）", () => {
    expect(referencedFieldNames([mk("qty", "数量"), mk("tot", "汇总", "rollup")])).toEqual(new Set());
  });
});

describe("evalFormula 取模与幂", () => {
  const ref = (_n: string) => null;

  it("% 与 / 同优先级、除零返回 null", () => {
    expect(evalFormula("7 % 3", ref)).toBe(1);
    expect(evalFormula("7 % 2.5", ref)).toBe(2);
    expect(evalFormula("1 + 2 % 2", ref)).toBe(1);
    expect(evalFormula("(1 + 2) % 2", ref)).toBe(1);
    expect(evalFormula("7 % 0", ref)).toBeNull();
    expect(evalFormula("6 / 2 % 4", ref)).toBe(3);
  });

  it("^ 右结合、优先于一元负号", () => {
    expect(evalFormula("2 ^ 3", ref)).toBe(8);
    expect(evalFormula("2 ^ 3 ^ 2", ref)).toBe(512);
    expect(evalFormula("-2 ^ 2", ref)).toBe(-4);
    expect(evalFormula("2 ^ -2", ref)).toBe(0.25);
    expect(evalFormula("1 + 2 * 3 ^ 2", ref)).toBe(19);
    expect(evalFormula("4 ^ 0.5", ref)).toBe(2);
  });

  it("^ 结果非有限数 → null", () => {
    expect(evalFormula("10 ^ 1000", ref)).toBeNull();
    expect(evalFormula("0 ^ -1", ref)).toBeNull();
  });
});

describe("evalFormula 文本函数", () => {
  const ref = (n: string) => ({ name: "x", empty: null })[n] ?? null;

  it("UPPER / LOWER / TRIM / LENGTH", () => {
    expect(evalFormula('UPPER("aBc")', ref)).toBe("ABC");
    expect(evalFormula("UPPER({name})", ref)).toBe("X");
    expect(evalFormula('LOWER("aBc")', ref)).toBe("abc");
    expect(evalFormula('TRIM("  hi  ")', ref)).toBe("hi");
    expect(evalFormula('LENGTH("hello")', ref)).toBe(5);
    expect(evalFormula('LENGTH("中文")', ref)).toBe(2);
  });

  it("CONTAINS 返回布尔且与 IF 真假语义对齐", () => {
    expect(evalFormula('CONTAINS("hello", "ell")', ref)).toBe(true);
    expect(evalFormula('CONTAINS("hello", "xyz")', ref)).toBe(false);
    expect(evalFormula('IF(CONTAINS("hello", "ell"), "y", "n")', ref)).toBe("y");
    expect(evalFormula('IF(NOT CONTAINS("hello", "xyz"), "y", "n")', ref)).toBe("y");
  });

  it("LEFT / RIGHT / MID 截取（越界钳制、n 非法为 null）", () => {
    expect(evalFormula('LEFT("hello", 2)', ref)).toBe("he");
    expect(evalFormula('LEFT("hello")', ref)).toBe("h");
    expect(evalFormula('RIGHT("hello", 2)', ref)).toBe("lo");
    expect(evalFormula('LEFT("hello", 99)', ref)).toBe("hello");
    expect(evalFormula('LEFT("hello", 0 - 1)', ref)).toBe("");
    expect(evalFormula('MID("hello", 2, 3)', ref)).toBe("ell");
    expect(evalFormula('MID("hello", 2)', ref)).toBe("ello");
    expect(evalFormula('MID("hello", 0, 2)', ref)).toBe("he");
    expect(evalFormula("LEFT({empty}, 2)", ref)).toBe("");
    expect(evalFormula('LEFT("abc", {empty})', ref)).toBeNull();
  });

  it("参数个数不对 → null", () => {
    expect(evalFormula('UPPER("a", "b")', ref)).toBeNull();
    expect(evalFormula("CONTAINS(1)", ref)).toBeNull();
    expect(evalFormula("MID(1)", ref)).toBeNull();
  });
});

describe("evalFormula 日期扩展（NOW / DAYS / 日期加减）", () => {
  // 本地正午构造：任何时区下日历日都稳定
  const ms = new Date(2026, 9, 8, 12, 0, 0).getTime();
  const secs = Math.floor(ms / 1000);
  const ref = (n: string) =>
    ({ date: "2026-10-08", dt: "2026-10-08T14:30:00", ms, secs, a: 2, empty: null })[n] ?? null;

  it("NOW() 为本地 YYYY-MM-DDTHH:mm:ss，且可被 YEAR/MONTH/DAY 消费", () => {
    const now = new Date();
    const v = evalFormula("NOW()", ref);
    expect(typeof v).toBe("string");
    expect(String(v)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(evalFormula("YEAR(NOW())", ref)).toBe(now.getFullYear());
    expect(evalFormula("MONTH(NOW())", ref)).toBe(now.getMonth() + 1);
  });

  it("DAYS 按本地日历日求差（d1 - d2），忽略时分秒", () => {
    expect(evalFormula('DAYS("2026-10-08", "2026-10-01")', ref)).toBe(7);
    expect(evalFormula('DAYS("2026-10-01", "2026-10-08")', ref)).toBe(-7);
    expect(evalFormula('DAYS("2026-10-08", "2026-10-08")', ref)).toBe(0);
    expect(evalFormula('DAYS("2026-01-01", "2025-12-31")', ref)).toBe(1);
  });

  it("DAYS 容忍 epoch 数字（秒/毫秒）与字符串混用", () => {
    expect(evalFormula("DAYS({ms}, {date})", ref)).toBe(0);
    expect(evalFormula("DAYS({secs}, {date})", ref)).toBe(0);
    expect(evalFormula("DAYS({ms}, {secs})", ref)).toBe(0);
    expect(evalFormula('DAYS({ms}, "2026-10-01")', ref)).toBe(7);
  });

  it("DAYS 非法输入/参数数 → null", () => {
    expect(evalFormula("DAYS({empty}, {date})", ref)).toBeNull();
    expect(evalFormula('DAYS("xyz", {date})', ref)).toBeNull();
    expect(evalFormula("DAYS({date})", ref)).toBeNull();
  });

  it("日期 ± 数字 = 按天平移，数字 + 日期亦可", () => {
    expect(evalFormula("{date} + 1", ref)).toBe("2026-10-09");
    expect(evalFormula("1 + {date}", ref)).toBe("2026-10-09");
    expect(evalFormula("{date} - 1", ref)).toBe("2026-10-07");
    expect(evalFormula("{date} + {a}", ref)).toBe("2026-10-10");
    expect(evalFormula('"2026-12-31" + 1', ref)).toBe("2027-01-01");
    expect(evalFormula('"2026-01-01" - 1', ref)).toBe("2025-12-31");
    expect(evalFormula("TODAY() + 0", ref)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("数值串仍优先按算术处理；日期串与文本运算无效", () => {
    expect(evalFormula('"5" + 2', ref)).toBe(7);
    expect(evalFormula('{date} + "x"', ref)).toBeNull();
    expect(evalFormula("{empty} + 1", ref)).toBeNull();
  });

  it("含时间的日期串平移保留时分秒", () => {
    expect(evalFormula("{dt} + 1", ref)).toBe("2026-10-09T14:30:00");
  });
});

describe("evalFormula epoch 数字日期（created_at 回归）", () => {
  const ms = new Date(2026, 9, 8, 12, 0, 0).getTime();
  const ref = (n: string) => ({ t: ms, s: Math.floor(ms / 1000) })[n] ?? null;

  it("数字按 <1e11 秒、否则毫秒解析（旧实现只收字符串 → 恒空）", () => {
    expect(evalFormula("YEAR({t})", ref)).toBe(2026);
    expect(evalFormula("MONTH({t})", ref)).toBe(10);
    expect(evalFormula("DAY({t})", ref)).toBe(8);
    expect(evalFormula("YEAR({s})", ref)).toBe(2026);
    expect(evalFormula("DAY({s})", ref)).toBe(8);
  });

  it("computeRowFormulas 直读 created_at 单元格的 epoch 数字", () => {
    const fields = [
      {
        id: "f1",
        database_view_id: "v1",
        name: "创建时间",
        field_type: "created_at",
        options: JSON.stringify({ kind: "none" }),
        width: 120,
        is_hidden: 0,
        position: 0,
      },
      {
        id: "f2",
        database_view_id: "v1",
        name: "年份",
        field_type: "formula",
        options: JSON.stringify({ kind: "formula", formula: "YEAR({创建时间})" }),
        width: 120,
        is_hidden: 0,
        position: 1,
      },
    ] as unknown as import("@/types/database").DatabaseField[];
    expect(computeRowFormulas({ f1: ms }, fields).get("f2")).toBe(2026);
  });
});

describe("validateFormula", () => {
  it("合法表达式（含新运算符/新函数）→ undefined", () => {
    expect(validateFormula("{a} + 1 * 2")).toBeUndefined();
    expect(validateFormula("7 % 3")).toBeUndefined();
    expect(validateFormula("2 ^ 3 ^ 2")).toBeUndefined();
    expect(validateFormula('IF(CONTAINS({name}, "x"), UPPER({name}), LENGTH({name}))')).toBeUndefined();
    expect(validateFormula("DAYS({创建时间}, TODAY())")).toBeUndefined();
  });

  it("空表达式不报错（视为未填写）", () => {
    expect(validateFormula("")).toBeUndefined();
    expect(validateFormula("   ")).toBeUndefined();
  });

  it("非法字符/未闭合引号或大括号 → lexer", () => {
    expect(validateFormula("1 + @")).toBe("lexer");
    expect(validateFormula('MID("abc", 1, 2) & 3')).toBe("lexer");
    expect(validateFormula('"abc')).toBe("lexer");
    expect(validateFormula("{a")).toBe("lexer");
  });

  it("结构不合法 → syntax", () => {
    expect(validateFormula("1 +")).toBe("syntax");
    expect(validateFormula("(1 + 2")).toBe("syntax");
    expect(validateFormula("IF(1,")).toBe("syntax");
    expect(validateFormula("1 2")).toBe("syntax");
    expect(validateFormula("a + 1")).toBe("syntax"); // 裸标识符
  });

  it("未知函数名不在语法层拦截（求值时才为 null）", () => {
    expect(validateFormula("FOO(1)")).toBeUndefined();
    expect(evalFormula("FOO(1)", () => null)).toBeNull();
  });
});
