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

/** 去掉某个标签的颜色配置（返回新表，不改原对象） */
export function omitTagColor(meta: TagColorMap, tag: string): TagColorMap {
  return Object.fromEntries(Object.entries(meta).filter(([k]) => k !== tag));
}

/** 标签改名时同步颜色配置：目标标签已有颜色则保留目标色，不覆盖 */
export function renameTagColor(meta: TagColorMap, from: string, to: string): TagColorMap {
  const out = omitTagColor(meta, from);
  const color = meta[from];
  if (color && out[to] === undefined) out[to] = color;
  return out;
}