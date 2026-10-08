import { describe, expect, it } from "vitest";
import { findInTree, patchTreeView } from "./tree";
import type { View, ViewNode } from "@/types/models";

// 构造最小 ViewNode：只覆盖被测纯函数用到的字段（id/name/icon/children 等浅字段）
function node(id: string, children: ViewNode[] = [], over: Partial<View> = {}): ViewNode {
  return {
    id,
    workspace_id: "ws",
    parent_id: null,
    name: `name-${id}`,
    icon: null,
    layout: "document",
    extra: "{}",
    position: 0,
    is_favorite: 0,
    is_trash: 0,
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    visited_at: null,
    source_id: null,
    tags: "[]",
    children,
    ...over,
  };
}

/** a > b > d，a > c 的两层树 */
function sampleTree(): ViewNode[] {
  return [node("a", [node("b", [node("d")]), node("c")])];
}

describe("findInTree", () => {
  it("命中顶层节点", () => {
    expect(findInTree(sampleTree(), "a")?.id).toBe("a");
  });

  it("命中深层子节点", () => {
    expect(findInTree(sampleTree(), "d")?.id).toBe("d");
  });

  it("找不到返回 null", () => {
    expect(findInTree(sampleTree(), "missing")).toBeNull();
    expect(findInTree([], "a")).toBeNull();
  });
});

describe("patchTreeView", () => {
  it("只更新目标节点，其余节点保持引用不变", () => {
    const tree = sampleTree();
    const next = patchTreeView(tree, "c", { name: "renamed", icon: "📁" });
    const c = findInTree(next, "c");
    expect(c?.name).toBe("renamed");
    expect(c?.icon).toBe("📁");
    // a 因路径上经历重建而变化，但兄弟子树 d 的引用应保持不变
    const nextD = findInTree(next, "d");
    const origD = findInTree(tree, "d");
    expect(nextD).toBe(origD);
  });

  it("不修改原树（不可变）", () => {
    const tree = sampleTree();
    patchTreeView(tree, "a", { name: "changed" });
    expect(tree[0].name).toBe("name-a");
  });

  it("能穿透多层找到深层节点", () => {
    const next = patchTreeView(sampleTree(), "d", { name: "deep" });
    expect(findInTree(next, "d")?.name).toBe("deep");
  });

  it("目标不存在时返回等值新树，内容不变", () => {
    const tree = sampleTree();
    const next = patchTreeView(tree, "ghost", { name: "x" });
    expect(findInTree(next, "a")?.name).toBe("name-a");
    expect(findInTree(next, "d")?.name).toBe("name-d");
  });
});
