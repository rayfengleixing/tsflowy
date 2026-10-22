// Markdown 双向转换（文本 ⇄ TipTap JSON）。
// parse.ts 负责导入侧，render.ts 负责导出侧；两侧共用的正则与常量归 parse.ts。

export { columnRatioOf, looksLikeMarkdown, markdownToJson, parseInline, textToBlocks } from "./parse";
export { alignValueOf, calloutColorOf, colorAttr, jsonToMarkdown } from "./render";
