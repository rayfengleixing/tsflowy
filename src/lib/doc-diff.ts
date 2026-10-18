import type { JSONContent } from "@tiptap/core";

import { logger } from "./logger";
import { jsonToMarkdown } from "./markdown";

/**
 * 文档历史版本的逐行对比。
 *
 * 快照存的是整份 doc JSON，直接比 JSON 会因为节点属性顺序、空段落而满屏飘红，
 * 所以两侧都先渲染成 Markdown 再按行比 —— 那才是用户真正在读的文本。
 * 纯函数，不碰 IPC：取内容由调用方做完（见 components/history-dialog.tsx）。
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** 中段过大退化成「整块删除 + 整块新增」：此时行级对应关系不可信 */
  capped: boolean;
}

/**
 * 中段（去掉公共前后缀之后）两侧的行数上限。LCS 表是 n×m，
 * 800 行约 2.5MB，再大就只是让用户看一屏飘红，不如直接整块列出。
 */
const MAX_MID_LINES = 800;

/** 文档 JSON → 可对比的 Markdown 文本。解析失败退回原文：宁可噪声大一点，也不要整块空白 */
export function contentToDiffText(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as JSONContent | JSONContent[];
    const doc: JSONContent = Array.isArray(parsed) ? { type: "doc", content: parsed } : parsed;
    return jsonToMarkdown(doc);
  } catch (e) {
    logger.warn("doc-diff: document json invalid", e);
    return raw;
  }
}

const splitLines = (text: string): string[] => (text ? text.split("\n") : []);

/** 公共前后缀先削掉：绝大多数版本只改一两段，剩下的中段才是真正要做 LCS 的部分 */
export function diffLines(before: string, after: string): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  const capped = midA.length > MAX_MID_LINES || midB.length > MAX_MID_LINES;
  const mid: DiffLine[] = capped
    ? [...midA.map((text) => ({ kind: "del" as const, text })), ...midB.map((text) => ({ kind: "add" as const, text }))]
    : lcsDiff(midA, midB);
  const lines: DiffLine[] = [
    ...a.slice(0, head).map((text) => ({ kind: "same" as const, text })),
    ...mid,
    ...a.slice(tailA).map((text) => ({ kind: "same" as const, text })),
  ];
  return {
    lines,
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
    capped,
  };
}

/** 经典 LCS 回溯；表按行铺平成一维，避免几万个小数组 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/**
 * 折叠未改动的长段：变更行连同上下 radius 行上下文标为可见，
 * 其余由调用方渲染成「省略 n 行」的分隔（文案走 i18n，所以这里只回布尔位图）。
 */
export function visibleFlags(lines: DiffLine[], radius = 2): boolean[] {
  const flags = lines.map(() => false);
  lines.forEach((line, idx) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, idx - radius); k <= Math.min(lines.length - 1, idx + radius); k++) flags[k] = true;
  });
  return flags;
}
