import { describe, expect, it } from "vitest";
import { opsForType } from "@/lib/database/database-query";
import type { CellValue, DatabaseField, FieldType } from "@/types/database";
import {
  COND_TONE_CELL,
  COND_TONE_DOT,
  COND_TONES,
  MAX_COND_RULES,
  buildCondIndex,
  condKey,
  isCondScope,
  isCondTone,
  newCondRule,
  parseCondFormats,
  toneOfIndex,
  type CondFormatRule,
} from "./database-cond-format";

const field = (id: string, field_type: FieldType): DatabaseField =>
  ({ id, field_type, name: id, is_hidden: 0, options: "{}" }) as DatabaseField;

const rule = (over: Partial<CondFormatRule> = {}): CondFormatRule => ({
  id: "c1",
  field_id: "n",
  op: "gt",
  value: 5,
  tone: "red",
  scope: "cell",
  ...over,
});

const cells = (m: Record<string, Record<string, CellValue>>) => m;
const fields = [field("n", "number"), field("t", "text")];
const rows = cells({ r1: { n: 10, t: "alpha" }, r2: { n: 1, t: "" } });
const rowIds = ["r1", "r2"];

describe("parseCondFormats", () => {
  it("keeps well-formed rules and drops the rest", () => {
    const raw = (over: Record<string, unknown>) => ({
      id: "c1",
      field_id: "n",
      op: "gt",
      value: 5,
      tone: "red",
      scope: "cell",
      ...over,
    });
    const parsed = parseCondFormats([
      raw({}),
      raw({ id: "c2", tone: "teal" }), // 未知颜色
      raw({ id: "c3", scope: "column" }), // 未知作用范围
      raw({ id: "c4", op: "near" }), // 未知比较符
      raw({ id: "" }), // 空 id 没法定位编辑
      raw({ id: "c5", field_id: undefined }), // 缺字段
      raw({ id: "c6", field_id: "" }), // 空字段
      null,
      "nope",
    ]);
    expect(parsed).toEqual([rule()]);
  });

  it("treats a missing operand as null and non-arrays as unconfigured", () => {
    expect(parseCondFormats(undefined)).toBeUndefined();
    expect(parseCondFormats("gt")).toBeUndefined();
    expect(parseCondFormats([])).toEqual([]);
    expect(parseCondFormats([{ id: "c1", field_id: "t", op: "is_empty", tone: "gray", scope: "row" }])).toEqual([
      { id: "c1", field_id: "t", op: "is_empty", value: null, tone: "gray", scope: "row" },
    ]);
  });

  it("clamps to the rule cap", () => {
    const many = Array.from({ length: MAX_COND_RULES + 5 }, (_, i) => rule({ id: "c" + i }));
    expect(parseCondFormats(many)).toHaveLength(MAX_COND_RULES);
  });
});

describe("newCondRule", () => {
  it("starts as a cell rule on the field's first operator", () => {
    const r = newCondRule("cdf_1", field("n", "number"));
    expect(r).toMatchObject({ id: "cdf_1", field_id: "n", scope: "cell", tone: "red" });
    expect(r.op).toBe(opsForType("number")[0]);
    // 新建的规则要能被 extra 认下来（否则配好就丢）
    expect(parseCondFormats([r])).toEqual([r]);
  });
});

describe("buildCondIndex / toneOfIndex", () => {
  it("colors only the matched rows of the ruled column", () => {
    const index = buildCondIndex([rule()], rowIds, rows, fields);
    expect(toneOfIndex(index, "r1", "n")).toBe("red");
    expect(toneOfIndex(index, "r2", "n")).toBeNull();
    // 同一行的其它列不受影响
    expect(toneOfIndex(index, "r1", "t")).toBeNull();
  });

  it("row rules land on the shared key and tint every column", () => {
    const index = buildCondIndex([rule({ scope: "row", tone: "green" })], rowIds, rows, fields);
    expect(index.get(condKey("r1", ""))).toBe("green");
    expect(toneOfIndex(index, "r1", "t")).toBe("green");
    expect(toneOfIndex(index, "r2", "n")).toBeNull();
  });

  it("first rule wins within a scope, but a cell rule beats a row rule on its own column", () => {
    const index = buildCondIndex(
      [rule({ id: "a", scope: "row", tone: "green" }), rule({ id: "b", scope: "row", tone: "blue" })],
      rowIds,
      rows,
      fields,
    );
    expect(toneOfIndex(index, "r1", "n")).toBe("green");

    const mixed = buildCondIndex(
      [rule({ id: "a", scope: "row", tone: "green" }), rule({ id: "b", scope: "cell", tone: "blue" })],
      rowIds,
      rows,
      fields,
    );
    expect(toneOfIndex(mixed, "r1", "n")).toBe("blue");
    expect(toneOfIndex(mixed, "r1", "t")).toBe("green");
  });

  it("silently ignores rules whose field is gone or whose operator no longer fits", () => {
    expect(buildCondIndex([rule({ field_id: "ghost" })], rowIds, rows, fields).size).toBe(0);
    // 字段从数字改成文本后，「> 5」这类比较符不再适用
    expect(buildCondIndex([rule()], rowIds, rows, [field("n", "text")]).size).toBe(0);
    expect(buildCondIndex([], rowIds, rows, fields).size).toBe(0);
    expect(buildCondIndex([rule()], [], rows, fields).size).toBe(0);
  });

  it("works with empty / text conditions", () => {
    const index = buildCondIndex(
      [{ id: "e", field_id: "t", op: "is_empty", value: null, tone: "gray", scope: "cell" }],
      rowIds,
      rows,
      fields,
    );
    expect(toneOfIndex(index, "r2", "t")).toBe("gray");
    expect(toneOfIndex(index, "r1", "t")).toBeNull();
  });

  it("reads missing rows and cells as empty instead of throwing", () => {
    const index = buildCondIndex(
      [{ id: "e", field_id: "n", op: "is_not_empty", value: null, tone: "yellow", scope: "cell" }],
      ["r1", "ghost", "r-empty"],
      cells({ r1: { n: 10 }, "r-empty": {} }),
      fields,
    );
    expect(toneOfIndex(index, "r1", "n")).toBe("yellow");
    expect(toneOfIndex(index, "ghost", "n")).toBeNull();
    expect(toneOfIndex(index, "r-empty", "n")).toBeNull();
  });
});

describe("调色板", () => {
  it("每个 tone 都有点色与底色两类类名", () => {
    for (const tone of COND_TONES) {
      expect(COND_TONE_DOT[tone]).toMatch(/bg-/);
      expect(COND_TONE_CELL[tone]).toMatch(/bg-/);
      expect(COND_TONE_CELL[tone]).toMatch(/dark:bg-/);
    }
  });

  it("守卫只认清单内的值", () => {
    expect(isCondTone("red")).toBe(true);
    expect(isCondTone("crimson")).toBe(false);
    expect(isCondScope("row")).toBe(true);
    expect(isCondScope("column")).toBe(false);
  });
});
