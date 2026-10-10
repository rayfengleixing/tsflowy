// AI 助手输入框的 @文件名 引用解析。
//
// 用户在消息里写 `@周报` 即引用工作区中的同名文档，其内容会作为「参考文档」
// 随 system prompt 一起下发给模型。名称解析放在纯函数里便于单测；
// 除按名字匹配外不做任何猜测，匹配不到就当普通文本，不影响正常提问。

export interface MentionCandidate {
  id: string;
  name: string;
}

export interface ResolvedMention {
  id: string;
  name: string;
}

/**
 * 从文本里解析 @文件名 引用。
 * · 按名字长度降序匹配并在命中后占用区间，避免「周报」误配到「周报归档」内部；
 * · 同一文档多次引用只保留一次；
 * · `@` 必须出现在行首或空白之后（邮箱 a@b.com 这类不误判）。
 */
export function parseMentions(text: string, candidates: MentionCandidate[]): ResolvedMention[] {
  const used: [number, number][] = [];
  const seen = new Set<string>();
  const hits: { id: string; name: string; at: number }[] = [];
  const ordered = candidates.filter((c) => c.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length);
  for (const c of ordered) {
    const token = "@" + c.name;
    let idx = text.indexOf(token);
    while (idx !== -1) {
      const end = idx + token.length;
      const boundary = idx === 0 || /\s/.test(text[idx - 1]);
      const overlaps = used.some(([s, e]) => idx < e && end > s);
      if (boundary && !overlaps) {
        used.push([idx, end]);
        if (!seen.has(c.id)) {
          seen.add(c.id);
          hits.push({ id: c.id, name: c.name, at: idx });
        }
        break;
      }
      idx = text.indexOf(token, idx + 1);
    }
  }
  // 按在消息中出现的先后返回，便于阅读与调试
  return hits.sort((a, b) => a.at - b.at).map(({ id, name }) => ({ id, name }));
}

/**
 * 输入框里当前光标处的 @ 查询词（用于驱动文件下拉）。
 * 返回 `@` 的起始位置与查询词；不在引用输入状态时返回 null。
 */
export function detectMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * @ 引用下拉的模糊匹配打分：分数越高越靠前，null 表示不匹配。
 * · 前缀 / 连续包含优先；
 * · 否则按「字符依次出现（子序列）」匹配，连续命中的片段加分——
 *   让「周报」能匹配「本周 报 告」这类跳字输入，也支持英文 zbj→「周报编」式拼音首字母之外的乱序容错。
 * 中文名按码点遍历，逐字匹配对 CJK 友好。
 */
export function mentionScore(name: string, query: string): number | null {
  const n = name.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const idx = n.indexOf(q);
  if (idx === 0) return 1_000_000;
  if (idx > 0) return 900_000 - idx;
  let score = 0;
  let from = 0;
  let prev = -1;
  for (const ch of q) {
    const found = n.indexOf(ch, from);
    if (found === -1) return null;
    // 与上一个命中字符紧邻 → 连续片段，额外加权
    score += found === prev + 1 ? 200 : 50;
    prev = found;
    from = found + 1;
  }
  // 名称越短越聚焦（同名命中时优先展示更贴切的）
  return 100_000 + score - n.length;
}
