// 标签元数据（颜色）：标签名本身存在 views.tags，这里只负责颜色，存 app_settings 的 tags.meta（JSON）。

/** app_settings 中标签元数据的键 */
export const TAG_META_KEY = "tags.meta";

/** 标签可选颜色：6 位 hex，便于拼 alpha 做浅色底 */
export const TAG_COLORS = [
  "#64748b", // 灰
  "#ef4444", // 红
  "#f97316", // 橙
  "#eab308", // 黄
  "#22c55e", // 绿
  "#06b6d4", // 青
  "#3b82f6", // 蓝
  "#a855f7", // 紫
  "#ec4899", // 粉
] as const;

/** 标签名 → 颜色 hex（未配置的键为 undefined） */
export type TagColorMap = Record<string, string | undefined>;

/** 安全解析 tags.meta（坏数据静默为空表） */
export function parseTagColors(raw: string | null | undefined): TagColorMap {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: TagColorMap = {};
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (typeof c === "string" && c) out[k] = c;
    }
    return out;
  } catch {
    return {};
  }
}

/** 未配置颜色的标签用稳定默认色：同名标签每次渲染颜色一致 */
export function defaultTagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

/** 取标签颜色：已配置优先，否则用稳定默认色 */
export function tagColor(tag: string, meta: TagColorMap): string {
  return meta[tag] ?? defaultTagColor(tag);
}

/** 颜色 → 带 alpha 的浅色底/描边（仅对 6 位 hex 生效，其它原样返回） */
export function tagTint(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}

/** 标签改名时同步颜色配置：整棵子树（含自身）的键按前缀替换；目标已有颜色则保留目标色 */
export function renameTagColor(meta: TagColorMap, from: string, to: string): TagColorMap {
  const out: TagColorMap = {};
  for (const [k, color] of Object.entries(meta)) {
    if (color === undefined) continue;
    const nk = renameTagPath(k, from, to);
    out[nk] ??= color;
  }
  return out;
}

// — 层级标签：标签名本身仍是扁平字符串，用「/」分层，如 "工作/项目A" —

/** 层级分隔符 */
export const TAG_SEP = "/";

/** 把标签名拆成层级段（过滤空段："/a//b/" → ["a","b"]） */
export function splitTagPath(tag: string): string[] {
  return tag.split(TAG_SEP).map((s) => s.trim()).filter(Boolean);
}

/** 标签是否命中筛选路径：完全相等，或位于其下（父路径前缀匹配，含所有子标签） */
export function tagMatchesFilter(tag: string, filter: string): boolean {
  return tag === filter || tag.startsWith(filter + TAG_SEP);
}

/** 按层级重写标签名：tag 命中 from 子树时，把 from 前缀替换为 to */
export function renameTagPath(tag: string, from: string, to: string): string {
  return tagMatchesFilter(tag, from) ? to + tag.slice(from.length) : tag;
}

/** 层级标签树节点（由扁平标签名聚合；中间层级 count 可能为 0） */
export interface TagTreeNode {
  /** 当前层级显示名 */
  label: string;
  /** 完整路径（父路径 + / + label），筛选与取色都用它 */
  path: string;
  /** 直接带此标签的页面数 */
  count: number;
  /** 含所有子标签的页面数（子树内直接计数之和） */
  total: number;
  children: TagTreeNode[];
}

/** 把「标签名 → 页面数」聚合成层级树（按名称排序，同名段自动合并） */
export function buildTagTree(entries: Iterable<readonly [string, number]>): TagTreeNode[] {
  const roots: TagTreeNode[] = [];
  const index = new Map<string, TagTreeNode>();
  for (const [tag, count] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = splitTagPath(tag);
    if (parts.length === 0) continue;
    let level = roots;
    let path = "";
    for (const seg of parts) {
      path = path ? `${path}${TAG_SEP}${seg}` : seg;
      let node = index.get(path);
      if (!node) {
        node = { label: seg, path, count: 0, total: 0, children: [] };
        index.set(path, node);
        level.push(node);
      }
      level = node.children;
    }
    const leaf = index.get(path);
    if (leaf) leaf.count += count;
  }
  const sum = (n: TagTreeNode): number => {
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    n.total = n.count + n.children.reduce((acc, c) => acc + sum(c), 0);
    return n.total;
  };
  roots.sort((a, b) => a.label.localeCompare(b.label));
  for (const r of roots) sum(r);
  return roots;
}

/** 去掉标签颜色配置：移除整棵子树（含自身）的键，返回新表 */
export function omitTagColor(meta: TagColorMap, tag: string): TagColorMap {
  const out: TagColorMap = {};
  for (const [k, color] of Object.entries(meta)) {
    if (color === undefined || tagMatchesFilter(k, tag)) continue;
    out[k] = color;
  }
  return out;
}