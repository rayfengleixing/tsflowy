// 粗略 token 估算：项目里上下文预算全部按「字符」计会明显失真——中文约 1 字 1 token，
// 拉丁文本约 4 字符 1 token。这里按码点区分宽文字（CJK / 假名 / 韩文 / 全角标点）与其余，
// 给一个不依赖分词器、误差对预算目的足够小的近似。

function isWide(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首、汉字、假名
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式标点
    (cp >= 0xff00 && cp <= 0xff60) || // 全角字符
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/** 估算一段文本的 token 数：宽文字 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    if (isWide(ch.codePointAt(0) ?? 0)) wide++;
    else other++;
  }
  return wide + Math.ceil(other / 4);
}

/** 保留尾部约 maxTokens 的内容（长消息截断时保新丢旧），至少留 1 个字符 */
export function tailTokens(text: string, maxTokens: number): string {
  if (!text || estimateTokens(text) <= maxTokens) return text;
  const chars = [...text];
  let tokens = 0;
  let start = chars.length - 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = isWide(chars[i].codePointAt(0) ?? 0) ? 1 : 0.25;
    if (tokens + w > maxTokens) break;
    tokens += w;
    start = i;
  }
  return chars.slice(start).join("");
}
