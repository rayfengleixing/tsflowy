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
  const used: Array<[number, number]> = [];
  const seen = new Set<string>();
  const hits: Array<{ id: string; name: string; at: number }> = [];
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
