// 父子行层级的纯计算：把扁平行集合按 parent_id 组织成森林，再按深度优先摊平成表格要显示的行序。
// 本仓库的 vitest 是 node 环境（没有 jsdom），表格里的缩进/折叠渲染测不了，
// 所以「谁是谁的子行、按什么顺序显示、谁还能再当父行」这些规则都收到这一层。
//
// 层级是行的结构属性（database_rows.parent_id 列），不是某一格的值：
// 它不进 database_cells，因此筛选/排序/汇总都不认识它，只有表格视图在未分组时把它展开成树。

/** 最深 4 层（顶层算第 1 层）。与 src-tauri/src/db/database.rs 的 MAX_ROW_LEVEL 同值，最终以 Rust 侧为准 */
export const MAX_HIERARCHY_LEVEL = 4;

/** 层级只看这两列，测试里传字面量即可 */
export interface HierRow {
  id: string;
  parent_id: string | null;
}

export interface HierLine<T extends HierRow> {
  row: T;
  /** 1 = 顶层行 */
  depth: number;
  /** 直接子行 id，按传入集合的顺序（表格视图传进来的是筛选/排序后的行序，兄弟行沿用它） */
  childIds: string[];
  /** 从顶层到「自身父行」的 id 链；行自身的折叠状态另看 collapsed */
  ancestors: string[];
  hasChildren: boolean;
  /** 自身有子行且被折叠 */
  collapsed: boolean;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

/**
 * 深度优先摊平 + 折叠隐藏，一趟算完每行的层深、直接子行与祖先链。
 * 折叠的父行仍占一行（带 collapsed 标记），它的整棵子树不输出。
 *
 * 父行不在集合里的行按顶层行处理：父行进了回收站、或父行被筛选条件挡掉，
 * 都不该让子行凭空消失——抬到顶层比藏起来更好解释。
 * 环（只可能来自手改库的脏数据）靠「已访问」集合打断，每行只输出一次。
 */
export function hierarchyLines<T extends HierRow>(
  rows: readonly T[],
  collapsed: ReadonlySet<string> = NO_COLLAPSED,
): HierLine<T>[] {
  const byId = new Map<string, T>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);

  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    const parent = r.parent_id != null && r.parent_id !== r.id ? byId.get(r.parent_id) : undefined;
    if (!parent) {
      roots.push(r);
      continue;
    }
    const list = kids.get(parent.id);
    if (list) list.push(r);
    else kids.set(parent.id, [r]);
  }

  const out: HierLine<T>[] = [];
  const seen = new Set<string>();
  const walk = (row: T, depth: number, ancestors: string[], hiddenByAncestor: boolean): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const children = kids.get(row.id) ?? [];
    const hasChildren = children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(row.id);
    if (!hiddenByAncestor) {
      out.push({
        row,
        depth,
        childIds: children.map((c) => c.id),
        ancestors,
        hasChildren,
        collapsed: isCollapsed,
      });
    }
    for (const c of children) walk(c, depth + 1, [...ancestors, row.id], hiddenByAncestor || isCollapsed);
  };
  for (const r of roots) walk(r, 1, [], false);

  // 只存在于环里的行永远走不到，按输入顺序补成顶层行（不展开它的子树，避免再撞环）
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ row: r, depth: 1, childIds: [], ancestors: [], hasChildren: false, collapsed: false });
  }
  return out;
}

/** 该行层深（顶层为 1）；行不在集合里返回 null */
export function hierarchyDepthOf(rows: readonly HierRow[], rowId: string): number | null {
  return hierarchyLines(rows).find((l) => l.row.id === rowId)?.depth ?? null;
}

/** 还能不能再往这行下面挂子行 */
export function canAddChild(rows: readonly HierRow[], rowId: string): boolean {
  const depth = hierarchyDepthOf(rows, rowId);
  return depth !== null && depth < MAX_HIERARCHY_LEVEL;
}

/**
 * 复制一批行时，新行该挂到谁下面（sourceIds 与 createdIds 一一对应，顺序同为源行顺序）。
 * 父行也在这批里 → 挂到它复制出来的那个新父行，整棵子树的形状跟着复制走；
 * 父行不在这批里 → 仍挂原来那行下面（父行还在库里，副本深度与源行一样，不会超深）；
 * 父行已经不在行集里（进了回收站、或本来就是脏引用）→ 副本落回顶层。
 */
export function duplicateParentMap(
  rows: readonly HierRow[],
  sourceIds: readonly string[],
  createdIds: readonly string[],
): (string | null)[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const copied = new Map<string, string>();
  for (let i = 0; i < sourceIds.length && i < createdIds.length; i++) {
    copied.set(sourceIds[i], createdIds[i]);
  }
  return sourceIds.map((id) => {
    const parentId = byId.get(id)?.parent_id;
    if (parentId == null) return null;
    return copied.get(parentId) ?? (byId.has(parentId) ? parentId : null);
  });
}

/**
 * 可选的父行候选：排除自己与自己的后代（否则会成环），
 * 且搬完不超深——被搬行下面整棵子树都要留在限额内，与 Rust 侧同一套限制。
 */
export function parentCandidates<T extends HierRow>(rows: readonly T[], childId: string): T[] {
  const lines = hierarchyLines(rows);
  const index = new Map(lines.map((l) => [l.row.id, l]));
  const child = index.get(childId);
  if (!child) return [];
  let below = 0;
  for (const l of lines) {
    if (l.row.id !== childId && l.ancestors.includes(childId)) below = Math.max(below, l.depth - child.depth);
  }
  const limit = MAX_HIERARCHY_LEVEL - 1 - below;
  return rows.filter((r) => {
    if (r.id === childId) return false;
    const l = index.get(r.id);
    return !!l && l.depth <= limit && !l.ancestors.includes(childId);
  });
}
