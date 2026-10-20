import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  updateFieldOptions: vi.fn((_id: string, _options: { options: SelectOption[] }): Promise<void> => Promise.resolve()),
}));

vi.mock("./database", () => ({ databaseApi: api }));

import { coerceCell } from "./ai-tools";
import type { DatabaseField, FieldType, SelectOption } from "@/types/database";

const field = (type: FieldType, options = "{}"): DatabaseField => ({
  id: "f1",
  database_view_id: "v1",
  name: "字段",
  field_type: type,
  options,
  width: 120,
  is_hidden: 0,
  position: 0,
});

const selectOptions = (names: string[]): string =>
  JSON.stringify({
    kind: "select",
    options: names.map((name, i) => ({ id: `opt${i}`, name, color: "blue" })),
  });

/** 第 n 次下发的选项列表（补建副作用断言用） */
const sentOptions = (n: number): SelectOption[] => api.updateFieldOptions.mock.calls[n][1].options;

beforeEach(() => api.updateFieldOptions.mockClear());

describe("coerceCell", () => {
  it("单选：命中已有选项落 id，未命中则补建选项后落新建 id", async () => {
    const f = field("status", selectOptions(["进行中"]));
    expect(await coerceCell(f, "进行中")).toBe("opt0");
    const created = await coerceCell(f, "待办");
    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).map((o) => o.name)).toEqual(["进行中", "待办"]);
    expect(created).toBe(sentOptions(0)[1].id);
    expect(created).not.toBe("待办"); // 裸名称当 id 会让展示、筛选、对端关联全部对不上
  });

  it("多选：未命中的名称补建为选项 id，同名只补一次", async () => {
    const f = field("multi_select", selectOptions(["甲"]));
    const ids = await coerceCell(f, ["甲", "乙", "乙"]);
    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).map((o) => o.name)).toEqual(["甲", "乙"]);
    expect(ids).toEqual(["opt0", sentOptions(0)[1].id, sentOptions(0)[1].id]);
  });

  it("多选：分隔串按中英逗号顿号拆分，空段丢弃", async () => {
    const f = field("multi_select", selectOptions(["甲", "乙"]));
    expect(await coerceCell(f, "甲，乙、甲,")).toEqual(["opt0", "opt1", "opt0"]);
    expect(api.updateFieldOptions).not.toHaveBeenCalled();
  });

  it("日期：把模型给的散文收成 ISO，解析不出才留原文", async () => {
    expect(await coerceCell(field("date"), "2024-01-05")).toBe("2024-01-05");
    // 具体时刻随本机时区变化，只断言「已归一成 ISO」
    expect(await coerceCell(field("date"), "2024/1/5")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await coerceCell(field("date"), "下周三见")).toBe("下周三见");
  });

  it("数字类剥掉单位与千分位，一个数字都没有时不落 0", async () => {
    expect(await coerceCell(field("number"), "1,234.5 元")).toBe(1234.5);
    expect(await coerceCell(field("progress"), "待定")).toBeNull();
    expect(await coerceCell(field("currency"), "—")).toBeNull();
  });

  it("只读与未支持类型不接受模型的值", async () => {
    for (const type of ["formula", "rollup", "relation"] as FieldType[]) {
      expect(await coerceCell(field(type), "任意")).toBeNull();
    }
  });
});
