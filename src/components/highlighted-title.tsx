import { TIER_BODY_ONLY, titleTier } from "@/lib/search";

const MARK = "rounded-sm bg-brand-100 text-brand-600";

/**
 * 标题里的关键词高亮（命令面板与搜索结果页共用）。
 * 直接子串命中按词高亮；仅拼音首字母命中（输入 "bj" 命中「笔记」）时整体高亮 ——
 * 首字母无法一一映射回汉字，标出整条标题比不标更好认。
 */
export function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const q = query.trim().toLowerCase();
  const tier = titleTier(title, q);
  if (!q || tier >= TIER_BODY_ONLY) return <>{title}</>;
  const lower = title.toLowerCase();
  if (!lower.includes(q)) return <mark className={MARK}>{title}</mark>;

  const parts: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < title.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: title.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ text: title.slice(i, idx), hit: false });
    parts.push({ text: title.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className={MARK}>
            {p.text}
          </mark>
        ) : (
          <span key={k}>{p.text}</span>
        ),
      )}
    </>
  );
}