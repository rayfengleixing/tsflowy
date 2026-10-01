/// <reference types="vite/client" />

// tiny-pinyin 的 dist 是手写 CommonJS、未带类型声明，这里补最小可用声明
declare module "tiny-pinyin" {
  export interface Token {
    source: string;
    /** 1 = ASCII，2 = 汉字拼音，3 = 未识别 */
    type: 1 | 2 | 3;
    target: string;
  }
  export function parse(str: string): Token[];
  export function convertToPinyin(str: string, separator?: string, lowerCase?: boolean): string;
  export function isSupported(force?: boolean): boolean;
}
