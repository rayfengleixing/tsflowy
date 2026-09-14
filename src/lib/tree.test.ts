import { describe, expect, it } from "vitest";
import { buildTree, computeRenumber, dropTarget, flattenTree, isDescendant, siblingIds } from "./tree";
import type { View } from "@/types/models";

const v = (id: string, parent_id: string | null, position: number): View => ({
  id,
  workspace_id: "w1",
  parent_id,
  name: id,
  icon: null,
  layout: "document",
  extra: "{}",
  position,
  is_favorite: 0,
  is_trash: 0,
  deleted_at: null,
  created_at: 0,
  updated_at: 0,
  visited_at: null,
  source_id: null, // 树里只有页面/宿主：派生视图由 Rust 侧查询排除
});

const views = [
  v("r1", null, 0),
  v("r2", null, 1),
  v("r3", null, 2),
  v("c1", "r1", 0),
  v("c2", "r1", 1),
  v("c3", "r1", 2),
];

describe("buildTree", () => {
  it("按 position 排序并嵌套", () => {
    const views = [v("b", "a", 1), v("a", null, 0), v("c", "a", 2), v("d", null, 1)];
    const tree = buildTree(views);
    expect(tree.map((n) => n.id)).toEqual(["a", "d"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("父节点缺失时视为根级", () => {
    const tree = buildTree([v("x", "ghost", 0)]);
    expect(tree.map((n) => n.id)).toEqual(["x"]);
  });
});

describe("flattenTree / isDescendant", () => {
  const tree = buildTree([v("a", null, 0), v("b", "a", 0), v("c", "b", 0), v("d", null, 1)]);
  it("先序遍历", () => {
    expect(flattenTree(tree).map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("后代判断", () => {
    expect(isDescendant(tree, "a", "c")).toBe(true);
    expect(isDescendant(tree, "b", "a")).toBe(false);
    expect(isDescendant(tree, "a", "d")).toBe(false);
  });
});

describe("computeRenumber", () => {
  it("同一父级内重排", () => {
    const updates = computeRenumber(views, "c3", "r1", 0);
    expect(updates.map((u) => [u.id, u.position])).toEqual([
      ["c3", 0],
      ["c1", 1],
      ["c2", 2],
    ]);
  });

  it("移动到另一父级末尾（index 越界收敛到末尾）", () => {
    const updates = computeRenumber(views, "c1", null, 99);
    const map = new Map(updates.map((u) => [u.id, u]));
    expect(map.get("c1")!.parent_id).toBeNull();
    expect(map.get("c1")!.position).toBe(3);
    expect(map.get("r1")!.position).toBe(0);
    expect(map.get("c2")!.position).toBe(0); // 旧父级兄弟重排
    expect(map.get("c3")!.position).toBe(1);
    expect(updates).toHaveLength(6);
  });

  it("移动到另一父级开头", () => {
    const updates = computeRenumber(views, "r3", "r1", 0);
    const map = new Map(updates.map((u) => [u.id, u]));
    expect(map.get("r3")!.parent_id).toBe("r1");
    expect(map.get("r3")!.position).toBe(0);
    expect(map.get("c1")!.position).toBe(1);
    expect(map.get("r1")!.position).toBe(0);
    expect(map.get("r2")!.position).toBe(1);
  });

  it("移动到根级中间", () => {
    const updates = computeRenumber(views, "c2", null, 1);
    const map = new Map(updates.map((u) => [u.id, u]));
    expect(map.get("c2")!.parent_id).toBeNull();
    expect(map.get("c2")!.position).toBe(1);
    expect(map.get("r2")!.position).toBe(2);
    expect(map.get("r3")!.position).toBe(3);
    expect(map.get("c1")!.position).toBe(0);
  });

  it("移动到自身当前位置无变化", () => {
    const updates = computeRenumber(views, "c2", "r1", 1);
    expect(updates).toEqual([]);
  });
});

describe("siblingIds", () => {
  it("排除被移动项", () => {
    expect(siblingIds(views, "r1", "c2")).toEqual(["c1", "c3"]);
    expect(siblingIds(views, null)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("dropTarget", () => {
  const tree = buildTree([v("r1", null, 0), v("r2", null, 1), v("c1", "r1", 0), v("c2", "r1", 1), v("d1", "c1", 0)]);

  it("before 落在兄弟前", () => {
    expect(dropTarget(tree, "r2", "before")).toEqual({ parentId: null, index: 1 });
    expect(dropTarget(tree, "c2", "before")).toEqual({ parentId: "r1", index: 1 });
  });

  it("after 落在兄弟后", () => {
    expect(dropTarget(tree, "c1", "after")).toEqual({ parentId: "r1", index: 1 });
  });

  it("inside 追加为目标子节点末尾", () => {
    expect(dropTarget(tree, "r1", "inside")).toEqual({ parentId: "r1", index: 2 });
    expect(dropTarget(tree, "c1", "inside")).toEqual({ parentId: "c1", index: 1 });
  });

  it("不存在返回 null", () => {
    expect(dropTarget(tree, "ghost", "before")).toBeNull();
  });
});
