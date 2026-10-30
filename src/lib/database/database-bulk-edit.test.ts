import { describe, expect, it } from "vitest";
import {
  bulkEditable,
  bulkOpsFor,
  bulkTargetValue,
  bulkValueKind,
  buildBulkUpdates,
  emptyBulkDraft,
  type BulkDraft,
  type BulkOp,
} from "./database-bulk-edit";
import { sparseGet } from "@/lib/database/database-values";
import type { CellValue, DatabaseField, FieldType } from "@/types/database";

const field = (field_type: FieldType, options: unknown = null): DatabaseField => ({
  id: `f-${field_type}`,
  database_view_id: "v1",
  name: field_type,
  field_type,
  options: options === null ? "{}" : JSON.stringify(options),
  width: 120,
  is_hidden: 0,
  position: 0,
});

const draft = (patch: Partial<BulkDraft> = {}): BulkDraft => ({ ...emptyBulkDraft(), ...patch });

/** 模拟 store 的稀疏 cells：只有被写过的行/字段才有条目 */
const reader = (table: Record<string, Record<string, CellValue>>) => (rowId: string, fieldId: string) => {
  const row = sparseGet(table, rowId);
  return row ? sparseGet(row, fieldId) : undefined;
};

describe("bulkOpsFor / bulkEditable", () => {
  it("只读列与需要专门选择器的字段不参与批量修改", () => {
    for (const t of ["formula", "rollup", "reverse_relation", "last_edited_at"]) {
      expect(bulkEditable(field(t as FieldType))).toBe(false);
      expect(bulkOpsFor(field(t as FieldType))).toEqual([]);
    }
    // 附件要文件对话框、关联要行选择器，「N 行填同一个值」语义不成立
    expect(bulkEditable(field("attachment"))).toBe(false);
    expect(bulkEditable(field("relation"))).toBe(false);
  });

  it("普通列给 设为/清空，复选框和多选各有专属操作", () => {
    expect(bulkOpsFor(field("text"))).toEqual(["set", "clear"]);
    expect(bulkOpsFor(field("checkbox"))).toEqual(["toggle", "set", "clear"]);
    expect(bulkOpsFor(field("multi_select"))).toEqual(["set", "add", "remove", "clear"]);
  });
});

describe("bulkValueKind", () => {
  it("清空与取反不需要值控件", () => {
    expect(bulkValueKind(field("text"), "clear")).toBe("none");
    expect(bulkValueKind(field("checkbox"), "toggle")).toBe("none");
  });

  it("控件形态跟着字段类型走", () => {
    expect(bulkValueKind(field("checkbox"), "set")).toBe("bool");
    expect(bulkValueKind(field("single_select"), "set")).toBe("single_option");
    expect(bulkValueKind(field("multi_select"), "add")).toBe("multi_option");
    expect(bulkValueKind(field("progress"), "set")).toBe("number");
    expect(bulkValueKind(field("date"), "set")).toBe("date");
    expect(bulkValueKind(field("created_at"), "set")).toBe("date");
    expect(bulkValueKind(field("url"), "set")).toBe("text");
  });
});

describe("bulkTargetValue", () => {
  it("文本去首尾空白，留空视为没填", () => {
    expect(bulkTargetValue(field("text"), draft({ text: "  嗨  " }))).toBe("嗨");
    expect(bulkTargetValue(field("text"), draft({ text: "   " }))).toBeNull();
  });

  it("数字认 NaN 与空串为没填", () => {
    expect(bulkTargetValue(field("number"), draft({ text: "42" }))).toBe(42);
    expect(bulkTargetValue(field("number"), draft({ text: "4.5" }))).toBe(4.5);
    expect(bulkTargetValue(field("currency"), draft({ text: "abc" }))).toBeNull();
    expect(bulkTargetValue(field("number"), draft({ text: "" }))).toBeNull();
  });

  it("进度压回 0-100 整数，星级按满星数封顶、0 星等于没打分", () => {
    expect(bulkTargetValue(field("progress"), draft({ text: "150" }))).toBe(100);
    expect(bulkTargetValue(field("progress"), draft({ text: "-3" }))).toBe(0);
    expect(bulkTargetValue(field("progress"), draft({ text: "40.6" }))).toBe(41);
    const rating = field("rating", { kind: "rating", max: 3 });
    expect(bulkTargetValue(rating, draft({ text: "5" }))).toBe(3);
    expect(bulkTargetValue(rating, draft({ text: "2" }))).toBe(2);
    expect(bulkTargetValue(rating, draft({ text: "0" }))).toBeNull();
  });

  it("日期按字段是否含时刻决定编码（与单元格编辑器一致）", () => {
    const day = field("date", { kind: "date", include_time: false });
    // 带时间的草稿给纯日期字段时只取到日，别把时刻塞进去
    expect(bulkTargetValue(day, draft({ text: "2026-10-15T08:30" }))).toBe("2026-10-15");
    expect(bulkTargetValue(day, draft({ text: "2026-10" }))).toBeNull();
    const withTime = field("date", { kind: "date", include_time: true });
    expect(bulkTargetValue(withTime, draft({ text: "2026-10-15T08:30" }))).toMatch(/Z$/);
    expect(bulkTargetValue(withTime, draft({ text: "不是日期" }))).toBeNull();
  });

  it("选择类：没选就是没填，多选的空数组是合法值", () => {
    expect(bulkTargetValue(field("single_select"), draft({ option: "" }))).toBeNull();
    expect(bulkTargetValue(field("single_select"), draft({ option: "o1" }))).toBe("o1");
    expect(bulkTargetValue(field("multi_select"), draft({ options: ["o1", "o2"] }))).toEqual(["o1", "o2"]);
    expect(bulkTargetValue(field("multi_select"), draft())).toEqual([]);
  });

  it("复选框取草稿的布尔目标值", () => {
    expect(bulkTargetValue(field("checkbox"), draft({ bool: false }))).toBe(false);
    expect(bulkTargetValue(field("checkbox"), draft({ bool: true }))).toBe(true);
  });
});

describe("buildBulkUpdates", () => {
  const run = (
    f: DatabaseField,
    op: BulkOp,
    target: CellValue,
    rowIds: string[],
    table: Record<string, Record<string, CellValue>>,
  ) => buildBulkUpdates({ field: f, op, target, rowIds, readCell: reader(table) });

  it("本来就是这个值的行被跳过——提示「已修改 N 行」要数得准", () => {
    const updates = run(field("text"), "set", "草稿", ["r1", "r2", "r3"], {
      r1: { "f-text": "草稿" },
      r2: { "f-text": "旧值" },
      r3: {}, // 有行记录但没有该字段的条目
    });
    expect(updates).toEqual([
      { rowId: "r2", fieldId: "f-text", value: "草稿" },
      { rowId: "r3", fieldId: "f-text", value: "草稿" },
    ]);
  });

  it("清空只作用在真正有值的行上", () => {
    const updates = run(field("text"), "clear", null, ["r1", "r2"], { r1: { "f-text": "x" }, r2: {} });
    expect(updates).toEqual([{ rowId: "r1", fieldId: "f-text", value: null }]);
  });

  it("取反把未填的复选框变成勾选", () => {
    const updates = run(field("checkbox"), "toggle", null, ["r1", "r2", "r3"], {
      r1: { "f-checkbox": true },
      r2: { "f-checkbox": false },
      r3: {},
    });
    // r1 勾选 → 取消；r2/r3 未勾 → 勾上
    expect(updates).toEqual([
      { rowId: "r1", fieldId: "f-checkbox", value: false },
      { rowId: "r2", fieldId: "f-checkbox", value: true },
      { rowId: "r3", fieldId: "f-checkbox", value: true },
    ]);
  });

  it("追加保住已有选项与顺序、去掉重复，移除只挑掉选中的", () => {
    const ms = field("multi_select");
    const added = run(ms, "add", ["o2", "o1"], ["r1"], { r1: { "f-multi_select": ["o1"] } });
    expect(added).toEqual([{ rowId: "r1", fieldId: "f-multi_select", value: ["o1", "o2"] }]);
    // 空单元格追加 = 直接落上下选的项
    expect(run(ms, "add", ["o1", "o2"], ["r9"], {})).toEqual([
      { rowId: "r9", fieldId: "f-multi_select", value: ["o1", "o2"] },
    ]);
    expect(run(ms, "remove", ["o1"], ["r1"], { r1: { "f-multi_select": ["o1", "o2"] } })).toEqual([
      { rowId: "r1", fieldId: "f-multi_select", value: ["o2"] },
    ]);
    // 全被移除后是空数组而不是 null：与单元格编辑器里的多选一致
    expect(run(ms, "remove", ["o1"], ["r1"], { r1: { "f-multi_select": ["o1"] } })).toEqual([
      { rowId: "r1", fieldId: "f-multi_select", value: [] },
    ]);
  });

  it("全部行都已是目标值时返回空列表，弹窗据此提示「没有改动」", () => {
    expect(
      run(field("text"), "set", "同一值", ["r1", "r2"], { r1: { "f-text": "同一值" }, r2: { "f-text": "同一值" } }),
    ).toEqual([]);
  });
});
