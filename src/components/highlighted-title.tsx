import { TIER_BODY_ONLY, titleTierFor } from "@/lib/search/search";

const MARK = "rounded-sm bg-brand-100 text-brand-600";

/**
 * 标题里的关键词高亮（命令面板与搜索结果页共用），多词查询逐词标。
 * 直接子串命中按词高亮；仅拼音首字母命中（输入 "bj" 命中「笔记」）时整体高亮 ——
 * 首字母无法一一映射回汉字，标出整条标题比不标更好认。
 */
export function HighlightedTitle({ title, terms }: { title: string; terms: string[] }) {
  if (titleTierFor(title, terms) >= TIER_BODY_ONLY) return <>{title}</>;

  const lower = title.toLowerCase();
  const hits: boolean[] = Array.from({ length: title.length }, () => false);
  for (const term of terms) {
    const q = term.trim().toLowerCase();
    if (!q) continue;
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
      for (let k = i; k < i + q.length; k++) hits[k] = true;
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < title.length) {
    const hit = hits[i];
    let end = i;
    while (end < title.length && hits[end] === hit) end++;
    parts.push({ text: title.slice(i, end), hit });
    i = end;
  }
  // 一个字面都没沾上 = 拼音命中，整条标出
  if (!parts.some((p) => p.hit)) return <mark className={MARK}>{title}</mark>;
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
