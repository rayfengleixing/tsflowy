import { describe, expect, it } from "vitest";
import {
  filterHits,
  localQualifierHits,
  localTitleHits,
  mergeSearchRows,
  parseSearchQuery,
  prioritizeSearchRows,
  sanitizeSnippet,
  TIER_BODY_ONLY,
  titleTier,
  titleTierFor,
  titleExcluded,
} from "./search";
import { DB_LAYOUTS } from "@/types/models";

// escapeFts / likePattern 的转义用例已随 Phase B 下沉 Rust（src-tauri/src/db/search.rs）。

describe("titleTier", () => {
  it("ranks exact > prefix > contains > pinyin > body-only", () => {
    expect(titleTier("笔记", "笔记")).toBe(0);
    expect(titleTier("笔记整理", "笔记")).toBe(1);
    expect(titleTier("我的笔记整理", "笔记")).toBe(2);
    expect(titleTier("完全不同", "笔记")).toBe(4);
    expect(titleTier("NOTE", "note")).toBe(0); // 大小写不敏感
  });

  it("matches by pinyin initials, ranked below literal title hits", () => {
    expect(titleTier("数据库表", "sjk")).toBe(3); // 拼音命中、字面不命中
    expect(titleTier("数据库表", "sjkb")).toBe(3);
    expect(titleTier("标题", "bt")).toBe(3);
    expect(titleTier("读书", "bt")).toBe(4); // 首字母串是 DS，不含 BT
    expect(titleTier("笔记整理", "bj")).toBe(3);
    expect(titleTier("笔记整理", "bjzl")).toBe(3);
    expect(titleTier("读书", "ds")).toBe(3);
  });
});

describe("titleTierFor", () => {
  it("requires every term to touch the title and takes the weakest match", () => {
    expect(titleTierFor("笔记整理", ["笔记", "笔记整"])).toBe(1); // 两词都是前缀级
    expect(titleTierFor("笔记整理", ["笔记", "整理"])).toBe(2); // 有一个词只是包含级
    expect(titleTierFor("笔记", ["笔记"])).toBe(0);
    expect(titleTierFor("笔记", ["笔记", "读书"])).toBe(TIER_BODY_ONLY); // 一个词不沾标题
    expect(titleTierFor("笔记", [])).toBe(TIER_BODY_ONLY);
  });

  it("expands pinyin per term, not for the joined query", () => {
    // 「笔记 sjk」整串既不是字面也不是首字母串；逐词判断才召得回
    expect(titleTier("笔记与数据库表", "笔记 sjk")).toBe(TIER_BODY_ONLY);
    expect(titleTierFor("笔记与数据库表", ["笔记", "sjk"])).toBe(3);
  });
});

describe("titleExcluded", () => {
  it("matches excluded terms literally or by pinyin initials", () => {
    expect(titleExcluded("项目计划", ["营收"])).toBe(false);
    expect(titleExcluded("营收报告", ["营收"])).toBe(true);
    expect(titleExcluded("营收报告", ["ys"])).toBe(true); // 首字母同样算命中
    expect(titleExcluded("营收报告", [])).toBe(false);
  });
});

describe("localTitleHits", () => {
  const views = [
    { id: "a", name: "数据库表", icon: null, layout: "document" as const },
    { id: "b", name: "读书", icon: "📖", layout: "grid" as const },
    { id: "c", name: "数据库读书笔记", icon: null, layout: "document" as const },
  ] as unknown as Parameters<typeof localTitleHits>[0];

  it("returns literal and pinyin title hits without touching the body", () => {
    expect(localTitleHits(views, ["sjk"]).map((r) => r.view_id)).toEqual(["a", "c"]);
    expect(localTitleHits(views, ["读书"]).map((r) => r.view_id)).toEqual(["b", "c"]);
  });

  it("applies AND across terms", () => {
    expect(localTitleHits(views, ["数据库", "笔记"]).map((r) => r.view_id)).toEqual(["c"]);
  });

  it("drops views whose title matches an excluded term", () => {
    expect(localTitleHits(views, ["sjk"], ["笔记"]).map((r) => r.view_id)).toEqual(["a"]);
    expect(localTitleHits(views, ["sjk"], ["sjk"])).toEqual([]);
  });

  it("returns nothing for empty terms, lone exclusion, or body-only match", () => {
    expect(localTitleHits(views, [])).toEqual([]);
    expect(localTitleHits(views, [], ["读书"])).toEqual([]);
    expect(localTitleHits(views, ["zzz"])).toEqual([]);
  });
});

describe("mergeSearchRows", () => {
  it("keeps the FTS row (with its snippet) when the same view matches locally", () => {
    const fts = [
      {
        view_id: "a",
        title: "数据库表",
        icon: null,
        layout: "document" as const,
        snippet: "<em>数据</em>正文",
        rank: 2,
      },
    ];
    const local = [{ view_id: "a", title: "数据库表", icon: null, layout: "document" as const, snippet: "", rank: 0 }];
    const out = mergeSearchRows(fts, local, ["sjk"]);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("<em>数据</em>正文");
  });

  it("orders pinyin title hits before body-only hits", () => {
    const fts = [
      { view_id: "b", title: "读书", icon: null, layout: "document" as const, snippet: "正文提到数据库", rank: 1 },
    ];
    const local = [{ view_id: "a", title: "数据库表", icon: null, layout: "document" as const, snippet: "", rank: 0 }];
    expect(mergeSearchRows(fts, local, ["sjk"]).map((r) => r.view_id)).toEqual(["a", "b"]);
  });
});

describe("prioritizeSearchRows", () => {
  const rows = [
    { view_id: "a", title: "日常笔记", icon: null, layout: "document" as const, snippet: "", rank: 5 },
    { view_id: "b", title: "笔记项目", icon: null, layout: "document" as const, snippet: "", rank: 1 },
    { view_id: "c", title: "读书", icon: null, layout: "document" as const, snippet: "笔记内容", rank: 2 },
    { view_id: "d", title: "笔记", icon: null, layout: "document" as const, snippet: "", rank: 9 },
  ];

  it("title matches come before body-only hits regardless of rank", () => {
    const out = prioritizeSearchRows(rows, ["笔记"]);
    expect(out.map((r) => r.view_id)).toEqual(["d", "b", "a", "c"]);
  });

  it("ranks by the weakest term in a multi-word query", () => {
    // 「笔记 读书」：d 两词都只算包含级，b 的 读书 不沾标题 → 落到正文级
    const two = [
      { view_id: "b", title: "笔记项目", icon: null, layout: "document" as const, snippet: "", rank: 1 },
      { view_id: "d", title: "读书笔记", icon: null, layout: "document" as const, snippet: "", rank: 2 },
    ];
    expect(prioritizeSearchRows(two, ["笔记", "读书"]).map((r) => r.view_id)).toEqual(["d", "b"]);
  });

  it("strips rank field from results", () => {
    const out = prioritizeSearchRows(rows, ["笔记"]);
    expect(out[0]).not.toHaveProperty("rank");
  });

  it("keeps row_id so a cell hit can locate the row", () => {
    const out = prioritizeSearchRows([{ ...rows[0], row_id: "r1" }], ["笔记"]);
    expect(out[0].row_id).toBe("r1");
  });

  it("does not mutate input order for same tier when rank differs", () => {
    const two = [
      { view_id: "x", title: "aaa", icon: null, layout: "document" as const, snippet: "", rank: 3 },
      { view_id: "y", title: "bbb", icon: null, layout: "document" as const, snippet: "", rank: 1 },
    ];
    expect(prioritizeSearchRows(two, ["zz"]).map((r) => r.view_id)).toEqual(["y", "x"]);
  });
});

describe("sanitizeSnippet", () => {
  it("keeps em markers only and strips other tags", () => {
    expect(sanitizeSnippet("a <em>b</em> c <script>x</script>")).toBe("a <em>b</em> c x");
  });
});

describe("parseSearchQuery", () => {
  it("splits qualifiers out of the keyword text", () => {
    expect(parseSearchQuery("笔记 type:page")).toEqual({
      text: "笔记",
      terms: ["笔记"],
      exclude: [],
      layouts: ["document"],
      tags: [],
    });
    expect(parseSearchQuery("type:database")).toEqual({
      text: "",
      terms: [],
      exclude: [],
      layouts: [...DB_LAYOUTS],
      tags: [],
    });
    expect(parseSearchQuery("type:页面 笔记")).toEqual({
      text: "笔记",
      terms: ["笔记"],
      exclude: [],
      layouts: ["document"],
      tags: [],
    });
    expect(parseSearchQuery("type:数据库")).toEqual({
      text: "",
      terms: [],
      exclude: [],
      layouts: [...DB_LAYOUTS],
      tags: [],
    });
    expect(parseSearchQuery("tag:工作 tag:重要 项目")).toEqual({
      text: "项目",
      terms: ["项目"],
      exclude: [],
      layouts: [],
      tags: ["工作", "重要"],
    });
  });

  it("lowercases qualifier values and keeps quoted phrases intact for the DB", () => {
    expect(parseSearchQuery('type:Board "项目 计划"')).toEqual({
      text: '"项目 计划"',
      terms: ["项目 计划"],
      exclude: [],
      layouts: ["board"],
      tags: [],
    });
    expect(parseSearchQuery("tag:Work")).toEqual({ text: "", terms: [], exclude: [], layouts: [], tags: ["work"] });
    // 列表 / 画廊两种数据库布局的英文与中文别名
    expect(parseSearchQuery("type:List")).toEqual({ text: "", terms: [], exclude: [], layouts: ["list"], tags: [] });
    expect(parseSearchQuery("type:画廊")).toEqual({
      text: "",
      terms: [],
      exclude: [],
      layouts: ["gallery"],
      tags: [],
    });
  });

  it("keeps each word as its own term instead of one joined phrase", () => {
    expect(parseSearchQuery("项目 计划")).toEqual({
      text: "项目 计划",
      terms: ["项目", "计划"],
      exclude: [],
      layouts: [],
      tags: [],
    });
    expect(parseSearchQuery('项目 "营收 报告" 计划').terms).toEqual(["项目", "营收 报告", "计划"]);
  });

  it("routes '-' prefixed words to exclude, quoted phrase included", () => {
    expect(parseSearchQuery("项目 -计划")).toEqual({
      text: "项目 -计划",
      terms: ["项目"],
      exclude: ["计划"],
      layouts: [],
      tags: [],
    });
    expect(parseSearchQuery('笔记 -"营收 报告"').exclude).toEqual(["营收 报告"]);
    // 只有排除项：没有正向词可与 NOT 组合（FTS5 不支持裸 NOT），searchApi 据此不发检索
    expect(parseSearchQuery("-笔记")).toEqual({
      text: "-笔记",
      terms: [],
      exclude: ["笔记"],
      layouts: [],
      tags: [],
    });
  });

  it("tolerates unbalanced quotes and a stray minus", () => {
    expect(parseSearchQuery('"笔记').terms).toEqual(["笔记"]);
    expect(parseSearchQuery("- 笔记").terms).toEqual(["笔记"]); // 单独的减号不成项
    expect(parseSearchQuery("- 笔记").text).toBe("笔记");
    expect(parseSearchQuery('笔记 "" ').terms).toEqual(["笔记"]);
  });

  it("drops unknown type values and bare 'type:' prefixes", () => {
    expect(parseSearchQuery("type:xyz 笔记")).toEqual({
      text: "笔记",
      terms: ["笔记"],
      exclude: [],
      layouts: [],
      tags: [],
    });
    expect(parseSearchQuery("type:")).toEqual({ text: "", terms: [], exclude: [], layouts: [], tags: [] });
  });
});

describe("localQualifierHits with exclusions", () => {
  const views = [
    { id: "a", name: "项目计划", icon: null, layout: "document", tags: "[]" },
    { id: "b", name: "营收项目表", icon: null, layout: "document", tags: "[]" },
  ] as unknown as Parameters<typeof localQualifierHits>[0];

  it("excludes by title only when there is no positive keyword to search", () => {
    expect(localQualifierHits(views, parseSearchQuery("type:page -营收")).map((r) => r.view_id)).toEqual(["a"]);
  });
});

describe("qualifier filtering", () => {
  const views = [
    { id: "a", name: "项目计划", icon: null, layout: "document", tags: '["工作"]' },
    { id: "b", name: "任务表", icon: null, layout: "grid", tags: '["工作","重要"]' },
    { id: "c", name: "读书", icon: "📖", layout: "document", tags: "[]" },
  ] as unknown as Parameters<typeof localQualifierHits>[0];

  it("localQualifierHits lists views by layout and tags", () => {
    expect(localQualifierHits(views, parseSearchQuery("type:database")).map((r) => r.view_id)).toEqual(["b"]);
    expect(localQualifierHits(views, parseSearchQuery("tag:工作")).map((r) => r.view_id)).toEqual(["a", "b"]);
    expect(localQualifierHits(views, parseSearchQuery("tag:工作 type:page")).map((r) => r.view_id)).toEqual(["a"]);
    expect(localQualifierHits(views, parseSearchQuery("tag:不存在"))).toEqual([]);
  });

  it("filterHits keeps only hits satisfying the qualifiers", () => {
    const hits = [
      { view_id: "a", title: "项目计划", icon: null, layout: "document" as const, snippet: "" },
      { view_id: "b", title: "任务表", icon: null, layout: "grid" as const, snippet: "" },
      { view_id: "c", title: "读书", icon: null, layout: "document" as const, snippet: "" },
    ];
    const tagsOf = (id: string) => (id === "a" ? ["工作"] : id === "b" ? ["工作", "重要"] : []);
    expect(filterHits(hits, parseSearchQuery("type:page"), tagsOf).map((h) => h.view_id)).toEqual(["a", "c"]);
    expect(filterHits(hits, parseSearchQuery("tag:工作"), tagsOf).map((h) => h.view_id)).toEqual(["a", "b"]);
    expect(filterHits(hits, parseSearchQuery("笔记"), tagsOf)).toHaveLength(3); // 无限定符原样返回
  });
});
