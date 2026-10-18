import { describe, expect, it, vi } from "vitest";

import { contentToDiffText, diffLines, visibleFlags } from "./doc-diff";

vi.mock("./logger", () => ({ logger: { warn: vi.fn() } }));

const doc = (lines: string[]) =>
  JSON.stringify({
    type: "doc",
    content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
  });

describe("diffLines", () => {
  it("marks only the changed line", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d.lines).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
    expect({ added: d.added, removed: d.removed, capped: d.capped }).toEqual({ added: 1, removed: 1, capped: false });
  });

  it("pairs an inserted paragraph without rewriting its neighbours", () => {
    const d = diffLines("标题\n第一段\n第三段", "标题\n第一段\n第二段\n第三段");
    expect(d.lines.filter((l) => l.kind !== "same")).toEqual([{ kind: "add", text: "第二段" }]);
  });

  it("reports no change for identical text and for two empty docs", () => {
    expect(diffLines("同样的内容", "同样的内容").lines.map((l) => l.kind)).toEqual(["same"]);
    expect(diffLines("", "").lines).toEqual([]);
  });

  it("degrades to whole blocks past the mid-size cap", () => {
    const before = Array.from({ length: 900 }, (_, i) => `旧${i}`).join("\n");
    const after = Array.from({ length: 900 }, (_, i) => `新${i}`).join("\n");
    const d = diffLines(before, after);
    expect(d.capped).toBe(true);
    expect(d.removed).toBe(900);
    expect(d.added).toBe(900);
    // 整块模式先列全部删除再列全部新增，不做行级配对
    expect(d.lines[0].kind).toBe("del");
    expect(d.lines[899].kind).toBe("del");
    expect(d.lines[900].kind).toBe("add");
  });
});

describe("visibleFlags", () => {
  it("keeps two lines of context around each change", () => {
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "same" as const, text: `l${i}` })),
      { kind: "del" as const, text: "old" },
      { kind: "add" as const, text: "new" },
      ...Array.from({ length: 4 }, (_, i) => ({ kind: "same" as const, text: `t${i}` })),
    ];
    expect(
      visibleFlags(lines, 1)
        .map((v, i) => (v ? i : null))
        .filter((i) => i !== null),
    ).toEqual([5, 6, 7, 8]);
  });

  it("returns all-false when nothing changed", () => {
    expect(visibleFlags([{ kind: "same", text: "a" }]).some(Boolean)).toBe(false);
  });
});

describe("contentToDiffText", () => {
  it("renders doc json as the markdown the user actually reads", () => {
    expect(contentToDiffText(doc(["第一段", "第二段"]))).toBe("第一段\n\n第二段\n");
  });

  it("turns an empty or missing document into empty text", () => {
    expect(contentToDiffText(null)).toBe("");
    expect(contentToDiffText("")).toBe("");
  });

  it("falls back to the raw string when the json is unreadable", () => {
    expect(contentToDiffText("{ 不是 json")).toBe("{ 不是 json");
  });
});
