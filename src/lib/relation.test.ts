import { describe, expect, it } from "vitest";
import {
  buildRelationPickerFields,
  computeRollup,
  primaryFieldOf,
  relationCellText,
  relationRowIds,
  relationRowLabel,
  relationRowText,
  relationTarget,
  rollupConfig,
  rollupFnsFor,
  searchRelationRows,
  type RelationDb,
} from "./relation";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";

const field = (
  id: string,
  type: DatabaseField["field_type"],
  options: unknown = { kind: "none" },
  extra: Partial<DatabaseField> = {},
): DatabaseField => ({
  id,
  database_view_id: "v1",
  name: id,
  field_type: type,
  options: JSON.stringify(options),
  width: 180,
  is_hidden: 0,
  position: 0,
  ...extra,
});

const row = (id: string, position = 0): DatabaseRow => ({
  id,
  database_view_id: "v1",
  position,
  document_id: null,
  created_at: 1,
  updated_at: 1,
});

const db = (
  fields: DatabaseField[],
  rows: DatabaseRow[],
  cells: Record<string, Record<string, CellValue>>,
): RelationDb => ({ fields, rows, cells });

describe("relationTarget", () => {
  it("reads the target view id from options", () => {
    expect(relationTarget(field("f1", "relation", { kind: "relation", target_view_id: "v2" }))).toBe("v2");
  });

  it("treats a missing/blank target as unconfigured", () => {
    expect(relationTarget(field("f1", "relation", { kind: "relation", target_view_id: "" }))).toBeNull();
    expect(relationTarget(field("f2", "text"))).toBeNull();
  });
});

describe("relationRowIds", () => {
  it("keeps only string ids", () => {
    expect(relationRowIds(["r1", "r2"])).toEqual(["r1", "r2"]);
    expect(relationRowIds(null)).toEqual([]);
    expect(relationRowIds("r1")).toEqual([]);
  });
});

describe("primaryFieldOf", () => {
  it("prefers the first visible field by position", () => {
    const hidden = field("f0", "text", undefined, { position: 0, is_hidden: 1 });
    const name = field("f1", "text", undefined, { position: 1 });
    const later = field("f2", "text", undefined, { position: 2 });
    expect(primaryFieldOf([later, hidden, name])?.id).toBe("f1");
  });

  it("falls back to any field when everything is hidden", () => {
    const hidden = field("f0", "text", undefined, { is_hidden: 1 });
    expect(primaryFieldOf([hidden])?.id).toBe("f0");
    expect(primaryFieldOf([])).toBeNull();
  });
});

describe("relationRowLabel / relationRowText", () => {
  const fields = [
    field("title", "text"),
    field("status", "single_select", {
      kind: "select",
      options: [{ id: "o1", name: "进行中", color: "blue" }],
    }),
  ];
  const rows = [row("r1"), row("r2", 1)];
  const cells = { r1: { title: "任务甲", status: "o1" }, r2: { title: "任务乙" } };

  it("labels a row with its primary field, translating option ids", () => {
    expect(relationRowLabel(db(fields, rows, cells), "r1")).toBe("任务甲");
    expect(relationRowText(db(fields, rows, cells), "r1")).toBe("任务甲 进行中");
  });

  it("returns null for rows that no longer exist", () => {
    expect(relationRowLabel(db(fields, rows, cells), "gone")).toBeNull();
  });

  it("relationCellText joins labels and degrades to raw ids", () => {
    expect(relationCellText(["r1", "r2"], db(fields, rows, cells))).toBe("任务甲, 任务乙");
    // 行已删：该 id 降级显示原始值
    expect(relationCellText(["r1", "ghost"], db(fields, rows, cells))).toBe("任务甲, ghost");
    // 目标库未加载：全部降级
    expect(relationCellText(["r1"], undefined)).toBe("r1");
    expect(relationCellText(null, db(fields, rows, cells))).toBe("");
  });
});

describe("searchRelationRows", () => {
  const fields = [field("title", "text")];
  const rows = [row("r1"), row("r2", 1)];
  const cells = { r1: { title: "任务甲" }, r2: { title: "Camping Trip" } };
  const target = db(fields, rows, cells);

  it("matches case-insensitively on any field text", () => {
    expect(searchRelationRows(target, "甲").map((r) => r.id)).toEqual(["r1"]);
    expect(searchRelationRows(target, "camping").map((r) => r.id)).toEqual(["r2"]);
  });

  it("returns every row for a blank query", () => {
    expect(searchRelationRows(target, "  ").map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("rollupConfig", () => {
  it("requires both the relation field and the target field", () => {
    const ok = { kind: "rollup", relation_field_id: "f1", target_field_id: "g1", fn: "count" };
    expect(rollupConfig(field("f9", "rollup", ok))).toEqual(ok);
    expect(rollupConfig(field("f9", "rollup", { ...ok, target_field_id: "" }))).toBeNull();
    expect(rollupConfig(field("f9", "text"))).toBeNull();
  });
});

describe("computeRollup", () => {
  const relField = field("rel", "relation", { kind: "relation", target_view_id: "v2" });
  const amount = field("amount", "number", { kind: "number", format: "decimal", precision: 2, currency: "CNY" });
  const target = db([amount], [row("t1"), row("t2", 1)], { t1: { amount: 10 }, t2: { amount: 32.5 } });
  const getDb = (id: string) => (id === "v2" ? target : undefined);

  it("aggregates the linked rows through the relation field", () => {
    const rollup = field("sum", "rollup", {
      kind: "rollup",
      relation_field_id: "rel",
      target_field_id: "amount",
      fn: "sum",
    });
    expect(computeRollup(rollup, { rel: ["t1", "t2"] }, [relField, amount, rollup], getDb)).toBe("42.50");
  });

  it("counts linked rows even when no target values are filled", () => {
    const rollup = field("cnt", "rollup", {
      kind: "rollup",
      relation_field_id: "rel",
      target_field_id: "amount",
      fn: "count",
    });
    expect(computeRollup(rollup, { rel: [] }, [relField, amount, rollup], getDb)).toBe("0");
  });

  it("returns null when configuration, relation field or target db is missing", () => {
    const unconfigured = field("r1", "rollup", {
      kind: "rollup",
      relation_field_id: "",
      target_field_id: "amount",
      fn: "sum",
    });
    expect(computeRollup(unconfigured, {}, [relField, unconfigured], getDb)).toBeNull();

    const noRelField = field("r2", "rollup", {
      kind: "rollup",
      relation_field_id: "ghost",
      target_field_id: "amount",
      fn: "sum",
    });
    expect(computeRollup(noRelField, {}, [relField, noRelField], getDb)).toBeNull();
    expect(computeRollup(noRelField, {}, [relField, noRelField], () => undefined)).toBeNull();
  });

  it("returns null when the target field was deleted", () => {
    const rollup = field("r3", "rollup", {
      kind: "rollup",
      relation_field_id: "rel",
      target_field_id: "ghost",
      fn: "sum",
    });
    expect(computeRollup(rollup, { rel: ["t1"] }, [relField, rollup], getDb)).toBeNull();
  });
});

describe("rollupFnsFor", () => {
  it("follows the aggregated field type, falling back to count when unknown", () => {
    const num = field("amount", "number");
    const text = field("note", "text");
    const target = db([num, text], [], {});
    expect(rollupFnsFor(target, "amount")).toContain("sum");
    expect(rollupFnsFor(target, "note")).not.toContain("sum");
    expect(rollupFnsFor(target, "ghost")).toEqual(["count"]);
    expect(rollupFnsFor(undefined, "amount")).toEqual(["count"]);
  });
});

describe("buildRelationPickerFields", () => {
  it("lists host database views that can be linked", () => {
    const views = [
      { id: "v1", name: "当前表", layout: "grid" as const, source_id: null },
      { id: "v2", name: "客户库", layout: "board" as const, source_id: null },
      { id: "v3", name: "文档页", layout: "document" as const, source_id: null },
      { id: "v4", name: "客户库(派生)", layout: "grid" as const, source_id: "v2" },
    ];
    expect(buildRelationPickerFields(views).map((v) => v.id)).toEqual(["v1", "v2"]);
  });
});
