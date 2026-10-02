import { describe, expect, it } from "vitest";
import {
  buildTagTree,
  canonicalTagName,
  defaultTagColor,
  omitTagColor,
  renameTagColor,
  renameTagPath,
  splitTagPath,
  tagColor,
  tagMatchesFilter,
} from "./tags";

describe("splitTagPath", () => {
  it("按 / 拆分层级并去掉空段", () => {
    expect(splitTagPath("工作/项目A")).toEqual(["工作", "项目A"]);
    expect(splitTagPath("/a//b/")).toEqual(["a", "b"]);
    expect(splitTagPath("")).toEqual([]);
  });
});

describe("canonicalTagName", () => {
  it("层级段去空白、去空段后重建；全空白得到空串", () => {
    expect(canonicalTagName(" 工作 / 项目A ")).toBe("工作/项目A");
    expect(canonicalTagName("//a//b/")).toBe("a/b");
    expect(canonicalTagName("   ")).toBe("");
  });
});

describe("tagMatchesFilter", () => {
  it("完全相等命中", () => {
    expect(tagMatchesFilter("工作", "工作")).toBe(true);
  });
  it("子层级按前缀命中", () => {
    expect(tagMatchesFilter("工作/项目A", "工作")).toBe(true);
    expect(tagMatchesFilter("工作/项目A/子", "工作/项目A")).toBe(true);
  });
  it("非层级边界不命中", () => {
    expect(tagMatchesFilter("工作台", "工作")).toBe(false);
    expect(tagMatchesFilter("其他", "工作")).toBe(false);
  });
  it("两侧先规范形再比较，空筛选不命中", () => {
    expect(tagMatchesFilter("工作 / 项目A", "工作")).toBe(true);
    expect(tagMatchesFilter("工作/项目A", " 工作 ")).toBe(true);
    expect(tagMatchesFilter("工作", "")).toBe(false);
  });
});

describe("renameTagPath", () => {
  it("替换自身与子树前缀", () => {
    expect(renameTagPath("工作", "工作", "职业")).toBe("职业");
    expect(renameTagPath("工作/项目A", "工作", "职业")).toBe("职业/项目A");
  });
  it("子树之外的标签不变", () => {
    expect(renameTagPath("工作台", "工作", "职业")).toBe("工作台");
  });
  it("非规范写法先规范再替换，未命中保持原样", () => {
    expect(renameTagPath("工作 / 项目A", "工作", "职业")).toBe("职业/项目A");
    expect(renameTagPath("生活 / 娱乐", "工作", "职业")).toBe("生活 / 娱乐");
  });
});

describe("tagColor", () => {
  it("原始键优先，其次规范键；不同空白写法落到同一默认色", () => {
    expect(tagColor("工作 / 项目A", { "工作/项目A": "#111111" })).toBe("#111111");
    expect(tagColor(" 工作 ", { 工作: "#222222" })).toBe("#222222");
    expect(tagColor("工作 / 项目A", {})).toBe(defaultTagColor("工作/项目A"));
  });
});

describe("buildTagTree", () => {
  it("按层级聚合，父节点汇总子标签计数", () => {
    const tree = buildTagTree([
      ["工作", 2],
      ["工作/项目A", 3],
      ["工作/项目A/子", 1],
      ["生活", 4],
    ]);
    expect(tree.map((n) => n.label)).toEqual(["工作", "生活"]);
    const work = tree[0];
    expect(work.path).toBe("工作");
    expect(work.count).toBe(2);
    expect(work.total).toBe(6);
    const projectA = work.children[0];
    expect(projectA.path).toBe("工作/项目A");
    expect(projectA.count).toBe(3);
    expect(projectA.total).toBe(4);
    expect(projectA.children[0].total).toBe(1);
    expect(tree[1].total).toBe(4);
  });

  it("中间层级不存在时补 0 计数节点", () => {
    const tree = buildTagTree([["工作/项目A", 1]]);
    expect(tree[0].path).toBe("工作");
    expect(tree[0].count).toBe(0);
    expect(tree[0].total).toBe(1);
  });
});

describe("层级颜色表", () => {
  it("改名同步整棵子树的颜色", () => {
    const meta = { 工作: "#111111", "工作/项目A": "#222222", 生活: "#333333" };
    expect(renameTagColor(meta, "工作", "职业")).toEqual({
      职业: "#111111",
      "职业/项目A": "#222222",
      生活: "#333333",
    });
  });
  it("删除移除整棵子树的颜色", () => {
    const meta = { 工作: "#111111", "工作/项目A": "#222222", 工作台: "#333333" };
    expect(omitTagColor(meta, "工作")).toEqual({ 工作台: "#333333" });
  });
});
