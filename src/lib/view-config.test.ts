import { describe, expect, it } from "vitest";
import { mergeViewConfig, parseViewConfig } from "./view-config";

describe("parseViewConfig", () => {
  it("reads a full config", () => {
    const cfg = parseViewConfig(
      JSON.stringify({
        mode: "board",
        filters: [{ id: "f1", field_id: "a", op: "contains", value: "x" }],
        filterMode: "or",
        sorts: [{ field_id: "b", dir: "desc" }],
        boardFieldId: "s1",
        calendarFieldId: "d1",
      }),
    );
    expect(cfg.mode).toBe("board");
    expect(cfg.filters).toHaveLength(1);
    expect(cfg.filterMode).toBe("or");
    expect(cfg.sorts).toEqual([{ field_id: "b", dir: "desc" }]);
    expect(cfg.boardFieldId).toBe("s1");
    expect(cfg.calendarFieldId).toBe("d1");
  });

  it("degrades safely on missing, damaged, or non-object extra", () => {
    expect(parseViewConfig(null)).toEqual({});
    expect(parseViewConfig(undefined)).toEqual({});
    expect(parseViewConfig("")).toEqual({});
    expect(parseViewConfig("{ not json")).toEqual({});
    expect(parseViewConfig("[]")).toEqual({});
    expect(parseViewConfig('"mode"')).toEqual({});
    expect(parseViewConfig("null")).toEqual({});
  });

  it("ignores unknown and malformed values instead of throwing", () => {
    const cfg = parseViewConfig(
      JSON.stringify({
        mode: "kanban", // 不在白名单
        filterMode: "maybe",
        sorts: [{ field_id: "b", dir: "sideways" }],
        filters: [{ nope: true }],
        boardFieldId: 42,
        calendarFieldId: "", // 空串 = 清除选择
      }),
    );
    expect(cfg.mode).toBeUndefined();
    expect(cfg.filterMode).toBeUndefined();
    expect(cfg.boardFieldId).toBeUndefined();
    expect(cfg.calendarFieldId).toBeUndefined();
    // 数组键存在但条目全畸形 → 空数组；非数组 → undefined
    expect(cfg.sorts).toEqual([]);
    expect(cfg.filters).toEqual([]);
    expect(parseViewConfig(JSON.stringify({ sorts: "nope" })).sorts).toBeUndefined();
  });

  it("keeps well-formed entries among malformed siblings", () => {
    const cfg = parseViewConfig(JSON.stringify({ sorts: [{ field_id: "ok", dir: "asc" }, { dir: "desc" }] }));
    expect(cfg.sorts).toEqual([{ field_id: "ok", dir: "asc" }]);
  });
});

describe("mergeViewConfig", () => {
  it("preserves foreign keys already in extra", () => {
    // row_detail 标记一旦被丢掉，行详情文档就会出现在页面树里（views.rs 靠 json_extract 过滤）
    const merged = mergeViewConfig('{"row_detail":true,"name":"keep"}', { mode: "grid" });
    const raw = JSON.parse(merged) as Record<string, unknown>;
    expect(raw.row_detail).toBe(true);
    expect(raw.name).toBe("keep");
    expect(raw.mode).toBe("grid");
  });

  it("survives damaged base text", () => {
    expect(JSON.parse(mergeViewConfig("{ broken", { mode: "board" }))).toEqual({ mode: "board" });
  });

  it("overwrites an existing config key and skips undefined", () => {
    const merged = mergeViewConfig('{"mode":"grid","sorts":[{"field_id":"a","dir":"asc"}]}', {
      mode: "calendar",
      sorts: undefined,
    });
    const raw = JSON.parse(merged) as Record<string, unknown>;
    expect(raw.mode).toBe("calendar");
    expect(raw.sorts).toEqual([{ field_id: "a", dir: "asc" }]);
  });

  it("round-trips every supported key through parse", () => {
    const patch = {
      mode: "board" as const,
      filters: [{ id: "f1", field_id: "a", op: "equals" as const, value: "v" }],
      filterMode: "or" as const,
      sorts: [{ field_id: "b", dir: "desc" as const }],
      boardFieldId: "s1",
      calendarFieldId: "d1",
    };
    expect(parseViewConfig(mergeViewConfig("{}", patch))).toEqual(patch);
  });

  it("keeps successive patches for one view instead of clobbering", () => {
    // 组件拿到的 view 是树快照、不会随写入刷新；第二次 patch 必须基于第一次的结果
    const first = mergeViewConfig('{"row_detail":true}', { mode: "grid" });
    const second = mergeViewConfig(first, { sorts: [{ field_id: "a", dir: "asc" }] });
    expect(parseViewConfig(second)).toEqual({ mode: "grid", sorts: [{ field_id: "a", dir: "asc" }] });
    expect((JSON.parse(second) as Record<string, unknown>).row_detail).toBe(true);
  });
});
