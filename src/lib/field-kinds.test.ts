import { describe, expect, it } from "vitest";
import { FIELD_TYPES, type FieldOptions, type FieldType } from "@/types/database";
import { defaultValue, validateCellValue } from "./database-values";
import { FIELD_KINDS, canGroupByKind, fieldKind, isDateKind, isOptionBearing } from "./field-kinds";

const opts = (o: FieldOptions): FieldOptions => o;
const NONE: FieldOptions = { kind: "none" };

/** 文本粘贴给不出值的类型 */
const skipsPaste = (type: FieldType): boolean => FIELD_KINDS[type].paste("x").kind === "skip";

describe("field-kinds 注册表完整性", () => {
  it("覆盖 FIELD_TYPES 的每一种类型", () => {
    for (const type of FIELD_TYPES) {
      expect(FIELD_KINDS[type], `缺少 ${type} 的 spec`).toBeDefined();
    }
  });

  it("未知类型按文本降级，不抛错", () => {
    const kind = fieldKind("not_a_type" as FieldType);
    expect(kind.domain).toBe("text");
    expect(kind.format("x", NONE)).toBe("x");
  });

  it("默认值能通过对外校验，且每种类型都有可用的筛选操作符", () => {
    for (const type of FIELD_TYPES) {
      // 走 database-values 的对外函数：同时证明委托没接错
      expect(validateCellValue(type, defaultValue(type)), `${type} 默认值非法`).toBe(true);
      expect(FIELD_KINDS[type].filterOps.length, `${type} 无筛选操作符`).toBeGreaterThan(0);
    }
  });

  it("无存储值的计算字段既不可分组，domain 也标成 computed 供 UI 判只读", () => {
    for (const type of ["formula", "rollup", "reverse_relation"] as FieldType[]) {
      expect(canGroupByKind(type), type).toBe(false);
      expect(FIELD_KINDS[type].domain, type).toBe("computed");
    }
    expect(canGroupByKind("last_edited_at")).toBe(false);
    expect(canGroupByKind("created_at")).toBe(true);
  });
});

describe("field-kinds 能力位与原 switch 一致", () => {
  it("日期语义含系统时间戳（筛选走按天聚拢 + 相对日期路径）", () => {
    const dateTypes: FieldType[] = ["date", "created_at", "last_edited_at"];
    expect(dateTypes.filter(isDateKind)).toEqual(dateTypes);
    expect(isDateKind("number")).toBe(false);
  });

  it("可分组的类型集合（复选框两桶无价值、关联/附件/计算字段不参与）", () => {
    const groupable = FIELD_TYPES.filter(canGroupByKind);
    expect(groupable).toEqual([
      "text",
      "number",
      "progress",
      "rating",
      "currency",
      "date",
      "single_select",
      "multi_select",
      "url",
      "phone",
      "email",
      "created_at",
    ]);
  });

  it("复选框只有勾选/未勾选两个操作符", () => {
    expect(FIELD_KINDS.checkbox.filterOps).toEqual(["checked", "unchecked"]);
  });

  it("带选项列表的类型只有单选/多选（导入预建选项、选项编辑器都读这一位）", () => {
    expect(FIELD_TYPES.filter(isOptionBearing)).toEqual(["single_select", "multi_select"]);
  });
});

describe("field-kinds 粘贴解读", () => {
  it("只有选择类交出选项名，其余给值或直接跳过", () => {
    const optionTypes = FIELD_TYPES.filter((t) => FIELD_KINDS[t].paste("甲 ; 乙").kind === "option_names");
    expect(optionTypes).toEqual(["single_select", "multi_select"]);
    expect(FIELD_KINDS.single_select.paste(" 新品类 ")).toEqual({ kind: "option_names", names: ["新品类"] });
    // 多选的拆分顺序/重复保留，去重由 pasteCell 在 id 层面做
    expect(FIELD_KINDS.multi_select.paste(" 甲 ; ; 乙|甲 ")).toEqual({
      kind: "option_names",
      names: ["甲", "乙", "甲"],
    });
  });

  it("文本给不出合法值的类型恒 skip：关联、附件、计算字段、最后编辑时间", () => {
    const skipTypes: FieldType[] = [
      "relation",
      "attachment",
      "formula",
      "rollup",
      "reverse_relation",
      "last_edited_at",
    ];
    for (const type of skipTypes) {
      expect(FIELD_KINDS[type].paste("任意文本"), type).toEqual({ kind: "skip" });
      expect(FIELD_KINDS[type].paste(""), type).toEqual({ kind: "skip" });
    }
    // created_at 不是系统只读字段（迁移历史数据要能回填），按文本原样存
    expect(FIELD_KINDS.created_at.paste("2020-01-01")).toEqual({ kind: "value", value: "2020-01-01" });
  });

  it("空串一律写成 null（清空单元格），非法数值也按空处理", () => {
    for (const type of FIELD_TYPES) {
      if (skipsPaste(type)) continue;
      const outcome = FIELD_KINDS[type].paste("   ");
      if (outcome.kind === "value") expect(outcome.value, type).toBeNull();
      if (outcome.kind === "option_names") expect(outcome.names, type).toEqual([]);
    }
    expect(FIELD_KINDS.number.paste("abc")).toEqual({ kind: "value", value: null });
    expect(FIELD_KINDS.progress.paste("65%")).toEqual({ kind: "value", value: 65 });
    expect(FIELD_KINDS.progress.paste("120")).toEqual({ kind: "value", value: 100 });
    expect(FIELD_KINDS.rating.paste("-3")).toEqual({ kind: "value", value: 0 });
    expect(FIELD_KINDS.checkbox.paste("是")).toEqual({ kind: "value", value: true });
    expect(FIELD_KINDS.checkbox.paste("yes")).toEqual({ kind: "value", value: false });
  });
});

describe("field-kinds 展示格式", () => {
  const select = opts({
    kind: "select",
    options: [
      { id: "o1", name: "进行中", color: "blue" },
      { id: "o2", name: "已完成", color: "green" },
    ],
  });

  it("数字族各自格式化：精度 / 百分比 / 星级 / 货币", () => {
    const num = opts({ kind: "number", format: "decimal", precision: 1, currency: "CNY" });
    expect(FIELD_KINDS.number.format(3.14, num)).toBe("3.1");
    expect(FIELD_KINDS.progress.format(62.7, NONE)).toBe("63%");
    expect(FIELD_KINDS.progress.format(140, NONE)).toBe("100%");
    expect(FIELD_KINDS.rating.format(3.4, opts({ kind: "rating", max: 5 }))).toBe("★★★☆☆");
    expect(
      FIELD_KINDS.currency.format(1234.5, opts({ kind: "number", format: "integer", precision: 0, currency: "USD" })),
    ).toBe(
      // 货币符号写法随系统 locale（zh-CN 出 US$1,235，en-US 出 $1,235），故按同一 locale 反推期望值
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(1234.5),
    );
  });

  it("脏值（类型不符）显示为空串", () => {
    expect(FIELD_KINDS.number.format("abc", NONE)).toBe("");
    expect(FIELD_KINDS.rating.format("abc", NONE)).toBe("");
    expect(FIELD_KINDS.date.format(123, NONE)).toBe("");
  });

  it("选项 id 解析成名称，选项被删则降级显示 id", () => {
    expect(FIELD_KINDS.single_select.format("o1", select)).toBe("进行中");
    expect(FIELD_KINDS.single_select.format("gone", select)).toBe("gone");
    expect(FIELD_KINDS.multi_select.format(["o2", "o1"], select)).toBe("已完成, 进行中");
    expect(FIELD_KINDS.multi_select.format(["o1"], NONE)).toBe("o1");
  });

  it("系统时间戳恒只到日，date 字段按 include_time 决定", () => {
    expect(FIELD_KINDS.created_at.format("2026-10-15T02:30:00Z", opts({ kind: "date", include_time: true }))).toBe(
      new Date("2026-10-15T02:30:00Z").toLocaleDateString(),
    );
    expect(FIELD_KINDS.date.format("2026-10-15T02:30:00Z", opts({ kind: "date", include_time: true }))).toBe(
      new Date("2026-10-15T02:30:00Z").toLocaleString(),
    );
    expect(FIELD_KINDS.date.format("2026-10-15T02:30:00Z", opts({ kind: "date", include_time: false }))).toBe(
      new Date("2026-10-15T02:30:00Z").toLocaleDateString(),
    );
  });

  it("附件取文件名串，关联取行 id 兜底文本", () => {
    expect(FIELD_KINDS.attachment.format([{ name: "合同.pdf", path: "assets/1.pdf" }], NONE)).toBe("合同.pdf");
    expect(FIELD_KINDS.attachment.format(["脏数据"], NONE)).toBe("");
    expect(FIELD_KINDS.relation.format(["r1", "r2"], NONE)).toBe("r1, r2");
  });
});
