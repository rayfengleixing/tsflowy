// 搜索历史（命令面板 / 搜索结果页共用）：只记「真正用过的查询」——
// 点开某条结果或跳去查看全部结果时记一条，而不是每敲一个字就记。
// 落 localStorage（与 settings store 同一降级策略：读写失败静默忽略）。

const KEY = "tsflowy:search-history";
const MAX = 8;

export function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** 记一条查询：去重（忽略大小写）后置顶，最多留 MAX 条 */
export function pushSearchHistory(query: string): void {
  const q = query.trim();
  if (!q) return;
  const rest = loadSearchHistory().filter((v) => v.toLowerCase() !== q.toLowerCase());
  try {
    localStorage.setItem(KEY, JSON.stringify([q, ...rest].slice(0, MAX)));
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}
