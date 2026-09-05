import { describe, expect, it } from "vitest";
import { prioritizeSearchRows, sanitizeSnippet, titleTier } from "./search";

// escapeFts / likePattern 的转义用例已随 Phase B 下沉 Rust（src-tauri/src/db/search.rs）。

describe("titleTier", () => {
  it("ranks exact > prefix > contains > body-only", () => {
    expect(titleTier("笔记", "笔记")).toBe(0);
    expect(titleTier("笔记整理", "笔记")).toBe(1);
    expect(titleTier("我的笔记整理", "笔记")).toBe(2);
    expect(titleTier("完全不同", "笔记")).toBe(3);
    expect(titleTier("NOTE", "note")).toBe(0); // 大小写不敏感
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
