// 文档内嵌数据库视图的纯逻辑层：选择器筛选、渲染态标题解析、行数上限。
// 与 subpages.ts 同思路，全部纯函数便于 Vitest 单测。
import type { LayoutType, View, ViewNode } from "@/types/models";
import { flattenTree, findNode } from "./tree";

/** 嵌入渲染的行数上限；完整数据通过「打开完整视图」跳转查看 */
export const EMBED_MAX_ROWS = 50;

const EMBEDDABLE_LAYOUTS: readonly LayoutType[] = ["grid", "board", "calendar", "timeline"];

/** 可嵌入文档的数据库视图：任意数据库布局（文档页/行详情页按 layout 天然排除） */
export function embeddableDatabaseViews(tree: ViewNode[]): View[] {
  return flattenTree(tree).filter((v) => EMBEDDABLE_LAYOUTS.includes(v.layout));
}

/** 嵌入视图头部标题：页面树里的当前名称优先，树中查不到回落插入时快照名/默认名 */
export function resolveDatabaseViewName(
  tree: ViewNode[],
  viewId: string | null,
  snapshotName: string,
  defaultName: string,
): string {
  const live = viewId ? findNode(tree, viewId)?.name : undefined;
  if (live?.trim()) return live;
  if (snapshotName.trim()) return snapshotName;
  return defaultName;
}
