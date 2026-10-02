import { describe, expect, it } from "vitest";
import { localTitleHits, mergeSearchRows, prioritizeSearchRows, sanitizeSnippet, titleTier } from "./search";

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

describe("localTitleHits", () => {
  const views = [
    { id: "a", name: "数据库表", icon: null, layout: "document" as const },
    { id: "b", name: "读书", icon: "📖", layout: "grid" as const },
  ] as Parameters<typeof localTitleHits>[0];

  it("returns literal and pinyin title hits without touching the body", () => {
    expect(localTitleHits(views, "sjk").map((r) => r.view_id)).toEqual(["a"]);
    expect(localTitleHits(views, "读书").map((r) => r.view_id)).toEqual(["b"]);
  });

  it("returns nothing for empty query or body-only match", () => {
    expect(localTitleHits(views, "   ")).toEqual([]);
    expect(localTitleHits(views, "zzz")).toEqual([]);
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
    const out = mergeSearchRows(fts, local, "sjk");
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("<em>数据</em>正文");
  });

  it("orders pinyin title hits before body-only hits", () => {
    const fts = [
      { view_id: "b", title: "读书", icon: null, layout: "document" as const, snippet: "正文提到数据库", rank: 1 },
    ];
    const local = [{ view_id: "a", title: "数据库表", icon: null, layout: "document" as const, snippet: "", rank: 0 }];
    expect(mergeSearchRows(fts, local, "sjk").map((r) => r.view_id)).toEqual(["a", "b"]);
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
    const out = prioritizeSearchRows(rows, "笔记");
    expect(out.map((r) => r.view_id)).toEqual(["d", "b", "a", "c"]);
  });

  it("strips rank field from results", () => {
    const out = prioritizeSearchRows(rows, "笔记");
    expect(out[0]).not.toHaveProperty("rank");
  });

  it("keeps row_id so a cell hit can locate the row", () => {
    const out = prioritizeSearchRows([{ ...rows[0], row_id: "r1" }], "笔记");
    expect(out[0].row_id).toBe("r1");
  });

  it("does not mutate input order for same tier when rank differs", () => {
    const two = [
      { view_id: "x", title: "aaa", icon: null, layout: "document" as const, snippet: "", rank: 3 },
      { view_id: "y", title: "bbb", icon: null, layout: "document" as const, snippet: "", rank: 1 },
    ];
    expect(prioritizeSearchRows(two, "zz").map((r) => r.view_id)).toEqual(["y", "x"]);
  });
});

describe("sanitizeSnippet", () => {
  it("keeps em markers only and strips other tags", () => {
    expect(sanitizeSnippet("a <em>b</em> c <script>x</script>")).toBe("a <em>b</em> c x");
  });
});
