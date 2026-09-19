import { parseViewTags, type View, type ViewNode } from "@/types/models";

// 树操作纯函数：与数据库解耦，便于 Vitest 单测（项目说明书 11 节：树操作需单测）

export function buildTree(views: View[]): ViewNode[] {
  const map = new Map<string, ViewNode>();
  for (const v of views) {
    map.set(v.id, { ...v, children: [] });
  }
  const roots: ViewNode[] = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: ViewNode[]) => {
    nodes.sort((a, b) => a.position - b.position);
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function flattenTree(nodes: ViewNode[]): ViewNode[] {
  const out: ViewNode[] = [];
  const walk = (ns: ViewNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function findNode(nodes: ViewNode[], id: string): ViewNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

export type DropZone = "before" | "inside" | "after";

/**
 * 拖拽落点 → 新父级 + 插入下标。
 * before/after 落在目标行的相邻位置（父级不变）；inside 追加为目标子节点末尾。
 * 找不到目标返回 null。
 */
export function dropTarget(
  nodes: ViewNode[],
  targetId: string,
  zone: DropZone,
): { parentId: string | null; index: number } | null {
  const target = findNode(nodes, targetId);
  if (!target) return null;
  if (zone === "inside") return { parentId: targetId, index: target.children.length };

  const walk = (ns: ViewNode[]): ViewNode[] | null => {
    if (ns.some((n) => n.id === targetId)) return ns;
    for (const n of ns) {
      const found = walk(n.children);
      if (found) return found;
    }
    return null;
  };
  const siblings = walk(nodes) ?? [];
  const idx = siblings.findIndex((n) => n.id === targetId);
  return { parentId: target.parent_id, index: zone === "before" ? idx : idx + 1 };
}

export function isDescendant(nodes: ViewNode[], ancestorId: string, targetId: string): boolean {
  const node = findNode(nodes, ancestorId);
  if (!node) return false;
  return flattenTree([node]).some((n) => n.id === targetId && n.id !== ancestorId);
}

/** 返回 parentId 下除 movedId 外的兄弟 id 列表（按 position 排序） */
export function siblingIds(views: View[], parentId: string | null, movedId?: string): string[] {
  return views
    .filter((v) => v.parent_id === parentId && v.id !== movedId)
    .sort((a, b) => a.position - b.position)
    .map((v) => v.id);
}

/** 标签过滤树：保留"自身带标签"或"子孙带标签"的节点（祖先仅作路径容器） */
export function filterTreeByTag(nodes: ViewNode[], tag: string): ViewNode[] {
  const walk = (ns: ViewNode[]): ViewNode[] => {
    const out: ViewNode[] = [];
    for (const n of ns) {
      const children = walk(n.children);
      const hit = parseViewTags(n.tags).includes(tag);
      if (hit || children.length > 0) out.push({ ...n, children });
    }
    return out;
  };
  return walk(nodes);
}

export interface PositionUpdate {
  id: string;
  parent_id: string | null;
  position: number;
}

/**
 * 计算移动后的完整重排结果：把 movedId 放到 newParentId 下 index 位置，
 * 返回所有需要更新的行（含父级变化与两侧兄弟重排）。index 越界时自动收敛。
 */
export function computeRenumber(
  views: View[],
  movedId: string,
  newParentId: string | null,
  index: number,
): PositionUpdate[] {
  const moving = views.find((v) => v.id === movedId);
  if (!moving) return [];
  const oldParent = moving.parent_id;
  const updates: PositionUpdate[] = [];

  const newIds = siblingIds(views, newParentId, movedId);
  const idx = Math.max(0, Math.min(index, newIds.length));
  newIds.splice(idx, 0, movedId);
  // 位置无变化（同父级、同顺序）时不做任何更新
  if (oldParent === newParentId && newIds.join() === siblingIds(views, newParentId).join()) {
    return [];
  }
  newIds.forEach((id, i) => updates.push({ id, parent_id: newParentId, position: i }));

  if (oldParent !== newParentId) {
    siblingIds(views, oldParent, movedId).forEach((id, i) => updates.push({ id, parent_id: oldParent, position: i }));
  }
  return updates;
}
