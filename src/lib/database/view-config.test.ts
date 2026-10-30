import { describe, expect, it } from "vitest";
import { mergeViewConfig, parseViewConfig } from "./view-config";

describe("parseViewConfig", () => {
  it("reads a full config", () => {
    const cfg = parseViewConfig(
      JSON.stringify({
        activeViewId: "v2",
        filters: [{ id: "f1", field_id: "a", op: "contains", value: "x" }],
        filterMode: "or",
        sorts: [{ field_id: "b", dir: "desc" }],
        boardFieldId: "s1",
        calendarFieldId: "d1",
      }),
    );
    expect(cfg.activeViewId).toBe("v2");
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
    expect(parseViewConfig('"sorts"')).toEqual({});
    expect(parseViewConfig("null")).toEqual({});
  });

  it("ignores unknown and malformed values instead of throwing", () => {
    const cfg = parseViewConfig(
      JSON.stringify({
        activeViewId: "", // 空串 = 未配置
        filterMode: "maybe",
        sorts: [{ field_id: "b", dir: "sideways" }],
        filters: [{ nope: true }],
        boardFieldId: 42,
        calendarFieldId: "", // 空串 = 清除选择
      }),
    );
    expect(cfg.activeViewId).toBeUndefined();
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
    const merged = mergeViewConfig('{"row_detail":true,"name":"keep"}', { activeViewId: "v1" });
    const raw = JSON.parse(merged) as Record<string, unknown>;
    expect(raw.row_detail).toBe(true);
    expect(raw.name).toBe("keep");
    expect(raw.activeViewId).toBe("v1");
  });

  it("survives damaged base text", () => {
    expect(JSON.parse(mergeViewConfig("{ broken", { activeViewId: "v1" }))).toEqual({ activeViewId: "v1" });
  });

  it("overwrites an existing config key and skips undefined", () => {
    const merged = mergeViewConfig('{"activeViewId":"v1","sorts":[{"field_id":"a","dir":"asc"}]}', {
      activeViewId: "v2",
      sorts: undefined,
    });
    const raw = JSON.parse(merged) as Record<string, unknown>;
    expect(raw.activeViewId).toBe("v2");
    expect(raw.sorts).toEqual([{ field_id: "a", dir: "asc" }]);
  });

  it("round-trips every supported key through parse", () => {
    const patch = {
      activeViewId: "v2",
      filters: [{ id: "f1", field_id: "a", op: "equals" as const, value: "v" }],
      filterMode: "or" as const,
      sorts: [{ field_id: "b", dir: "desc" as const }],
      boardFieldId: "s1",
      calendarFieldId: "d1",
      groupFieldIds: ["g1", "g2"],
      galleryFieldId: "a1",
      aggregates: { n1: "sum" as const, b1: "checked" as const },
      condFormats: [
        { id: "c1", field_id: "n1", op: "gt" as const, value: 100, tone: "red" as const, scope: "cell" as const },
        { id: "c2", field_id: "b1", op: "checked" as const, value: null, tone: "gray" as const, scope: "row" as const },
      ],
      cardFieldIds: ["f2", "f3"],
    };
    expect(parseViewConfig(mergeViewConfig("{}", patch))).toEqual(patch);
  });

  it("drops malformed conditional-format rules and keeps unknown extra keys", () => {
    const good = { id: "c1", field_id: "n1", op: "gt", value: 5, tone: "red", scope: "cell" };
    const merged = mergeViewConfig('{"row_detail":true}', {
      condFormats: [
        { id: "c1", field_id: "n1", op: "gt" as const, value: 5, tone: "red" as const, scope: "cell" as const },
      ],
    });
    const raw = JSON.parse(merged) as Record<string, unknown>;
    expect(raw.row_detail).toBe(true);
    expect(parseViewConfig(merged).condFormats).toEqual([good]);
    // 非法比较符的那条整条丢掉（写进 extra 的脏数据只能这样兜）
    expect(parseViewConfig(JSON.stringify({ condFormats: [{ ...good, id: "c2", op: "near" }] })).condFormats).toEqual(
      [],
    );
    expect(parseViewConfig(JSON.stringify({ condFormats: "gt" })).condFormats).toBeUndefined();
    expect(parseViewConfig(mergeViewConfig("{}", { condFormats: [] })).condFormats).toEqual([]);
  });

  it("drops unknown aggregate names and non-string card ids", () => {
    const cfg = parseViewConfig(
      JSON.stringify({
        groupFieldId: "", // 旧键空串 = 清除选择
        groupFieldIds: [42, "", "ok", "ok", "x", "y"],
        galleryFieldId: "",
        aggregates: { n1: "sum", m1: "median", s1: "share", ghost: "percentile", "": "count" },
        cardFieldIds: ["f2", 42, null],
      }),
    );
    expect(cfg.groupFieldIds).toEqual(["ok", "x", "y"]);
    expect(cfg.galleryFieldId).toBeUndefined();
    // 中位数 / 占比是新函数，extra 里的名字得认；不认识的（percentile）丢掉
    expect(cfg.aggregates).toEqual({ n1: "sum", m1: "median", s1: "share" });
    expect(cfg.cardFieldIds).toEqual(["f2"]);
    expect(parseViewConfig(JSON.stringify({ aggregates: "sum" })).aggregates).toBeUndefined();
    expect(parseViewConfig(JSON.stringify({ aggregates: [] })).aggregates).toBeUndefined();
    expect(parseViewConfig(mergeViewConfig("{}", { aggregates: {} })).aggregates).toEqual({});
  });

  it("keeps successive patches for one view instead of clobbering", () => {
    // 组件拿到的 view 是树快照、不会随写入刷新；第二次 patch 必须基于第一次的结果
    const first = mergeViewConfig('{"row_detail":true}', { activeViewId: "v1" });
    const second = mergeViewConfig(first, { sorts: [{ field_id: "a", dir: "asc" }] });
    expect(parseViewConfig(second)).toEqual({ activeViewId: "v1", sorts: [{ field_id: "a", dir: "asc" }] });
    expect((JSON.parse(second) as Record<string, unknown>).row_detail).toBe(true);
  });
});
