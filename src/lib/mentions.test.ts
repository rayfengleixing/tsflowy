import { describe, expect, it } from "vitest";
import { resolveMentionName } from "./mentions";
import type { LayoutType, View, ViewNode } from "@/types/models";

const v = (id: string, name: string, layout: LayoutType = "document", children: ViewNode[] = []): ViewNode => {
  const base: View = {
    id,
    workspace_id: "w1",
    parent_id: null,
    name,
    icon: null,
    layout,
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
  };
  return { ...base, children };
};

const tree = [v("root", "首页", "document", [v("p1", "改名后的页面"), v("p2", "   ")])];

describe("resolveMentionName", () => {
  it("树里的当前名称优先：页面重命名后双链显示新名而非插入时快照", () => {
    expect(resolveMentionName(tree, "p1", "旧名字", "无标题页面")).toBe("改名后的页面");
  });

  it("树中查不到（页面已删除/离线）回落插入时快照 label", () => {
    expect(resolveMentionName(tree, "gone", "快照名", "无标题页面")).toBe("快照名");
  });

  it("目标页无名称时显示无标题文案（与插入时行为一致）", () => {
    expect(resolveMentionName(tree, "p2", "快照名", "无标题页面")).toBe("无标题页面");
  });

  it("id 缺失时回落快照", () => {
    expect(resolveMentionName(tree, "", "快照名", "无标题页面")).toBe("快照名");
  });
});
