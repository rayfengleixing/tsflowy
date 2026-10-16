// 中日韩文档不能按空格数词：一句「今天讨论了两个方案」是 11 个字，TipTap 自带的
// characterCount.words() 会数成 1（它按空白分词），阅读时长也就跟着崩。
// 这里按「汉字记 1、拉丁词记 1」混算，两套阅读速度分开折算再相加。

export interface WordCount {
  /** 中日韩字符数（每字算一个词） */
  cjk: number;
  /** 拉丁/西里尔等非 CJK 词数 */
  latin: number;
  /** cjk + latin */
  total: number;
}

/** CJK 统一表意文字（含扩展 A）、日文假名、韩文音节 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** 一个非 CJK 词：连续的字母数字，允许词内的撇号与连字符（don't、well-known） */
const LATIN_WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** 阅读速度（字/分钟、词/分钟）：中文母语者默读约 300 字，英文约 220 词 */
export const CJK_CHARS_PER_MINUTE = 300;
export const LATIN_WORDS_PER_MINUTE = 220;

export function countWords(text: string): WordCount {
  let cjk = 0;
  let latinText = "";
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      cjk += 1;
      latinText += " "; // 汉字当作词边界，别让左右两边的拉丁词粘成一个
    } else {
      latinText += ch;
    }
  }
  const latin = latinText.match(LATIN_WORD_RE)?.length ?? 0;
  return { cjk, latin, total: cjk + latin };
}

/** 预计阅读分钟数：有内容就至少 1 分钟，向上取整（显示「约 3 分钟」比「约 0.4 分钟」好读） */
export function readingMinutes(count: WordCount): number {
  if (count.total === 0) return 0;
  const minutes = count.cjk / CJK_CHARS_PER_MINUTE + count.latin / LATIN_WORDS_PER_MINUTE;
  return Math.max(1, Math.ceil(minutes));
}
