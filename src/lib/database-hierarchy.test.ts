import { describe, expect, it } from "vitest";
import {
  MAX_HIERARCHY_LEVEL,
  canAddChild,
  duplicateParentMap,
  hierarchyDepthOf,
  hierarchyLines,
  parentCandidates,
  type HierRow,
} from "./database-hierarchy";

const row = (id: string, parent_id: string | null = null): HierRow => ({ id, parent_id });
const ids = (rows: readonly HierRow[], collapsed?: ReadonlySet<string>) =>
  hierarchyLines(rows, collapsed).map((l) => l.row.id);
const depths = (rows: readonly HierRow[]) =>
  hierarchyLines(rows)
    .map((l) => `${l.row.id}:${l.depth}`)
    .join(" ");

describe("hierarchyLines", () => {
  it("keeps the input order when nothing has a parent", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(hierarchyLines(rows).every((l) => l.depth === 1 && !l.hasChildren)).toBe(true);
  });

  it("walks each subtree right after its parent and numbers levels from 1", () => {
    const rows = [row("p1"), row("c1", "p1"), row("p2"), row("g1", "c1"), row("c2", "p2")];
    expect(ids(rows)).toEqual(["p1", "c1", "g1", "p2", "c2"]);
    expect(depths(rows)).toBe("p1:1 c1:2 g1:3 p2:1 c2:2");
  });

  it("orders siblings by the incoming row order, not by id", () => {
    // 表格排过序的行序要原样保留在同一父行的兄弟之间
    const rows = [row("b", "p"), row("a", "p"), row("p")];
    expect(ids(rows)).toEqual(["p", "b", "a"]);
  });

  it("treats a parent outside the visible set as top level", () => {
    const rows = [row("x", "gone"), row("y", "y")];
    expect(ids(rows)).toEqual(["x", "y"]);
    expect(depths(rows)).toBe("x:1 y:1");
  });

  it("reports children and the ancestor chain", () => {
    const lines = hierarchyLines([row("p"), row("c", "p"), row("g", "c")]);
    const p = lines[0];
    expect(p.childIds).toEqual(["c"]);
    expect(p.hasChildren).toBe(true);
    expect(lines[2].ancestors).toEqual(["p", "c"]);
  });

  it("hides a collapsed subtree but keeps the collapsed row itself", () => {
    const rows = [row("p"), row("c", "p"), row("g", "c"), row("sibling")];
    const collapsed = new Set(["p"]);
    expect(ids(rows, collapsed)).toEqual(["p", "sibling"]);
    expect(hierarchyLines(rows, collapsed)[0].collapsed).toBe(true);
    expect(hierarchyLines(rows)[0].collapsed).toBe(false);
  });

  it("keeps descendants of an already hidden row hidden when a deeper row is also collapsed", () => {
    const rows = [row("p"), row("c", "p"), row("g", "c")];
    expect(ids(rows, new Set(["p", "c"]))).toEqual(["p"]);
    expect(ids(rows, new Set(["c"]))).toEqual(["p", "c"]);
  });

  it("leaves a leaf row rendered normally when it is in the collapsed set", () => {
    const lines = hierarchyLines([row("p"), row("c", "p")], new Set(["c"]));
    expect(lines.map((l) => l.collapsed)).toEqual([false, false]);
  });

  it("outputs every row once when the data contains a parent cycle", () => {
    // 手改库造成的环：不能死循环，也不能把行弄丢
    const rows = [row("a", "b"), row("b", "a"), row("free")];
    const out = ids(rows);
    expect(out).toEqual(["free", "a", "b"]);
    expect(new Set(out).size).toBe(3);
  });
});

describe("层级限额", () => {
  const chain = () => [row("l1"), row("l2", "l1"), row("l3", "l2"), row("l4", "l3")];

  it("counts levels up to the limit", () => {
    expect(hierarchyDepthOf(chain(), "l4")).toBe(MAX_HIERARCHY_LEVEL);
    expect(canAddChild(chain(), "l3")).toBe(true);
    expect(canAddChild(chain(), "l4")).toBe(false);
    expect(canAddChild(chain(), "ghost")).toBe(false);
  });

  it("offers only parents that keep the subtree inside the limit", () => {
    const rows = [...chain(), row("other")];
    // 把 l2（下面还挂着 l3、l4）往下搬最多只能到第 1 层行之下
    expect(parentCandidates(rows, "l2").map((r) => r.id)).toEqual(["l1", "other"]);
    // 整条四层链没有还能当父行的行：再挂就超深
    expect(parentCandidates(rows, "l1")).toEqual([]);
    // 叶子行还剩三层空间，但第 4 层的 l4 不能当父行
    expect(parentCandidates(rows, "l4").map((r) => r.id)).toEqual(["l1", "l2", "l3", "other"]);
    expect(parentCandidates(rows, "other").map((r) => r.id)).toEqual(["l1", "l2", "l3"]);
  });

  it("never offers the row itself or one of its descendants", () => {
    const rows = [row("p"), row("c", "p"), row("x")];
    const cand = parentCandidates(rows, "p").map((r) => r.id);
    expect(cand).toEqual(["x"]);
  });

  it("returns nothing for a row that is not in the set", () => {
    expect(parentCandidates(chain(), "ghost")).toEqual([]);
  });
});

describe("duplicateParentMap", () => {
  it("re-parents copies onto the copied parent so the subtree shape travels", () => {
    const rows = [row("p"), row("c1", "p"), row("g", "c1")];
    // sourceIds 与 createdIds 一一对应（顺序同为源行顺序）
    expect(duplicateParentMap(rows, ["p", "c1", "g"], ["np", "nc1", "ng"])).toEqual([null, "np", "nc1"]);
  });

  it("keeps the original parent when only the child is copied", () => {
    const rows = [row("p"), row("c", "p")];
    expect(duplicateParentMap(rows, ["c"], ["nc"])).toEqual(["p"]);
  });

  it("falls back to top level when the parent no longer exists", () => {
    // 父行进了回收站：脏引用不该把副本挂到一个不存在的行上
    expect(duplicateParentMap([row("c", "gone")], ["c"], ["nc"])).toEqual([null]);
  });

  it("maps a top-level source row to no parent", () => {
    expect(duplicateParentMap([row("p")], ["p"], ["np"])).toEqual([null]);
  });
});
