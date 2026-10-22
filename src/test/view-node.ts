import type { LayoutType, ViewNode } from "@/types/models";

/**
 * 用例里的页面树节点：只写关心的字段，其余按「刚建出来的普通文档页」补齐。
 * 抽出来是因为 lib 侧不再经 store 拿树（见 lib/app-context），多个用例都要自己造树。
 */
export function viewNode(
  id: string,
  name: string,
  overrides: Partial<ViewNode> & { layout?: LayoutType; children?: ViewNode[] } = {},
): ViewNode {
  return {
    id,
    name,
    workspace_id: "w1",
    parent_id: null,
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
    aliases: "[]",
    children: [],
    ...overrides,
  };
}
