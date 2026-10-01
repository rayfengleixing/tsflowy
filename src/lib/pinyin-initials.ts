import { isSupported, parse } from "tiny-pinyin";

// 中文 → 拼音首字母。
//
// 原先手写了一张几百字的映射表（只收界面词条），「笔记整理」这类自定义标题会整条落空，
// 拼音搜索基本触发不了。改用 tiny-pinyin：它靠 Intl.Collator 的 zh-CN 排序 + 一张约 8KB 的
// UNIHANS 边界表覆盖整个 CJK 基本区，体积代价约 12KB（gzip 后更小），准确率远高于手写表。
// 运行环境没有中文 ICU 数据时 isSupported() 为 false，退化为空串，调用方自带降级匹配。

const CACHE_MAX = 2000;
const cache = new Map<string, string>();

function convert(text: string): string {
  let out = "";
  // tiny-pinyin 逐字产出 token：type 2 = 汉字拼音、1 = ASCII、3 = 未识别
  for (const token of parse(text)) {
    if (token.type === 2) {
      out += token.target.charAt(0).toUpperCase();
    } else if (token.type === 1 && /[a-zA-Z0-9]/.test(token.target)) {
      out += token.target.toUpperCase();
    }
  }
  return out;
}

/** 中文文本 → 拼音首字母串（英文/数字原样转大写），如 "标题 1" → "BT1" */
export function pinyinInitials(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const out = isSupported() ? convert(text) : "";
  // 命令面板每次键击都会对所有标题求首字母，给张缓存兜住开销（标题集合变动不频繁）
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(text, out);
  return out;
}