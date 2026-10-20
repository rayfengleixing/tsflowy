// 文档内查找替换（Ctrl+F）
//
// 纯逻辑放这里，UI 见 features/editor/FindReplaceBar.tsx：
//   - 命中按块收集：把每个文本块的文本片段映射回文档位置，跨 mark 的命中也能整段选中；
//   - 高亮走 decoration（不改文档），活动项单独上色；
//   - 替换/全部替换用一条事务从后往前落，位置不互相污染；
//   - 支持「区分大小写」「全词匹配」「正则」三个开关（见 FindOptions，默认关闭时行为与旧版一致）；
//     正则档的替换串按 JS 语义展开捕获组（$1、$&、$$）。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";

export const findReplaceKey = new PluginKey<FindState>("findReplace");

/** 命中数上限：单字符查询在长文里会出几千个 decoration，超出部分不参与高亮；
 *  「全部替换」同样只作用于上限内命中，UI（FindReplaceBar）负责提示结果不完整 */
const MAX_MATCHES = 1000;

/** 文档编辑后延迟重算的尾抖动时长：太长高亮跟不上，太短等于没节流 */
const RECOMPUTE_DELAY = 150;

/** 就地全量替换的分批轮次上限：一批 MAX_MATCHES 个，正常文档一轮就够，
 *  留上限只为防「替换串本身又含查询词」这类自我放大的死循环 */
const MAX_REPLACE_ROUNDS = 50;

export interface FindMatch {
  from: number;
  to: number;
}

/** 匹配选项；不传时保持旧默认（忽略大小写、不做全词、不用正则） */
export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

type ResolvedFindOptions = Required<FindOptions>;

const NO_OPTIONS: ResolvedFindOptions = { caseSensitive: false, wholeWord: false, regex: false };

export interface FindState {
  query: string;
  options: ResolvedFindOptions;
  matches: FindMatch[];
  /** 当前命中下标；无命中为 -1 */
  active: number;
  /** 命中数触顶（MAX_MATCHES）：超出部分未参与高亮，UI 须提示结果不完整 */
  truncated: boolean;
  /** 正则档下表达式非法：当作无命中，但 UI 要区分「没找到」和「写错了」 */
  invalid: boolean;
}

type FindMeta =
  | { type: "setQuery"; query: string; options: ResolvedFindOptions }
  | { type: "setActive"; index: number }
  | { type: "clear" }
  | { type: "recompute" };

/** 全文拼接索引：每个可匹配字符对应一个文档位置 */
interface TextIndex {
  text: string;
  /** posMap[i] = 第 i 个字符在文档中的位置 */
  posMap: number[];
}

/** 原子 inline 节点（image/mention 等）在拼接索引中的占位符（U+FFFC，OBJ 字符） */
const ATOM_SENTINEL = String.fromCharCode(0xfffc);

/**
 * 递归拼接整篇文档的文本：
 *   - 文本节点逐字符映射（pos + i）；
 *   - 非文本叶子（image/mention 等 atom）以 ATOM_SENTINEL 占位，hardBreak 以 \n 占位——
 *     旧实现直接拼接 textContent 会让跨 hardBreak 的假命中出现；
 *   - 块级兄弟之间插 \n：既不产生跨块假命中，也允许显式含 \n 的查询跨块匹配。
 */
function stitchNode(node: ProseMirrorNode, pos: number, text: string[], posMap: number[]) {
  if (node.isText && node.text) {
    for (let i = 0; i < node.text.length; i++) {
      text.push(node.text[i]);
      posMap.push(pos + i);
    }
    return;
  }
  if (node.isLeaf) {
    text.push(node.type.name === "hardBreak" ? "\n" : ATOM_SENTINEL);
    posMap.push(pos);
    return;
  }
  // doc 无开闭标记，子节点从 pos 起算；其余容器节点子节点从 pos+1 起算
  const base = pos + (node.type.name === "doc" ? 0 : 1);
  let first = true;
  node.forEach((child, offset) => {
    if (!child.isInline && !first) {
      text.push("\n");
      posMap.push(base + offset);
    }
    first = false;
    stitchNode(child, base + offset, text, posMap);
  });
}

function buildTextIndex(doc: ProseMirrorNode): TextIndex {
  const text: string[] = [];
  const posMap: number[] = [];
  stitchNode(doc, 0, text, posMap);
  return { text: text.join(""), posMap };
}

export interface FindScan {
  matches: FindMatch[];
  truncated: boolean;
  invalid: boolean;
}

/**
 * 全词边界字符类：仅拉丁字母（含常见带变音的扩展区）、数字、下划线算「词字符」。
 * 中日韩等书写系统不使用词间空格，一律视为「非词字符」——因此「全词匹配」对
 * 纯中文/日文查询等价于不限制（如「测试」仍能命中「这是一个测试文本」），
 * 它只约束拉丁词/数字：查 "the" 不再命中 "there"，查 "123" 不命中 "a123"。
 */
const WORD_CHAR = /[A-Za-z0-9_\u00C0-\u00FF\u0100-\u024F\u1E00-\u1EFF]/;

function isWholeWordAt(text: string, idx: number, len: number): boolean {
  const before = idx > 0 ? text[idx - 1] : "";
  const after = text[idx + len] ?? "";
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after));
}

/** 正则档扫描：与全文扫描共用同一份 posMap，非法表达式当无命中（invalid=true 交给 UI 提示）。
 *  大小写不敏感直接用 `i` 修饰符跑原文，不做 toLowerCase——省掉长度漂移那一类坑。 */
function scanRegex(
  text: string,
  posMap: number[],
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): FindScan {
  let re: RegExp;
  try {
    re = new RegExp(query, caseSensitive ? "g" : "gi");
  } catch {
    return { matches: [], truncated: false, invalid: true };
  }
  const matches: FindMatch[] = [];
  let count = 0;
  let truncated = false;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    // 零宽命中（x*、^ 一类）不能进结果：位置无意义，而且 lastIndex 不动会死循环
    if (m[0].length > 0) {
      const end = m.index + m[0].length - 1;
      if (end >= posMap.length) break;
      if (!wholeWord || isWholeWordAt(text, m.index, m[0].length)) {
        count++;
        if (count > MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({ from: posMap[m.index], to: posMap[end] + 1 });
      }
    }
    if (re.lastIndex === m.index) re.lastIndex++;
    m = re.exec(text);
  }
  return { matches, truncated, invalid: false };
}

/** 全档扫描：块内/跨块/跨 atom 的映射统一走拼接索引，命中超 MAX_MATCHES 提前止损 */
export function scanMatches(doc: ProseMirrorNode, query: string, options: FindOptions = {}): FindScan {
  if (!query) return { matches: [], truncated: false, invalid: false };
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const { text, posMap } = buildTextIndex(doc);
  if (options.regex) return scanRegex(text, posMap, query, caseSensitive, wholeWord);
  let hay = text;
  let needle = query;
  if (!caseSensitive) {
    hay = text.toLowerCase();
    needle = query.toLowerCase();
    // toLowerCase 偶尔改变长度（如 İ→i̇，两字符）导致字符↔位置错位：
    // 长度不一致时退回大小写敏感匹配，保证位置映射可靠
    if (hay.length !== text.length) {
      hay = text;
      needle = query;
    }
  }
  const matches: FindMatch[] = [];
  let count = 0;
  let truncated = false;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    // 全词不成立时从下一字符继续找（词边界不满足的候选可能内嵌更长候选的开头）
    if (wholeWord && !isWholeWordAt(text, idx, needle.length)) {
      idx = hay.indexOf(needle, idx + 1);
      continue;
    }
    count++;
    if (count > MAX_MATCHES) {
      truncated = true;
      break;
    }
    matches.push({ from: posMap[idx], to: posMap[idx + needle.length - 1] + 1 });
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return { matches, truncated, invalid: false };
}

/** 兼容旧调用方：只取命中列表 */
export function collectMatches(doc: ProseMirrorNode, query: string): FindMatch[] {
  return scanMatches(doc, query).matches;
}

export function getFindState(editor: Editor): FindState | null {
  return findReplaceKey.getState(editor.state) ?? null;
}

/** 设置查询词与匹配选项并自动跳到首个命中 */
export function setFindQuery(editor: Editor, query: string, options: FindOptions = {}) {
  if (editor.isDestroyed) return;
  const resolved: ResolvedFindOptions = {
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    regex: options.regex === true,
  };
  editor.view.dispatch(
    editor.state.tr.setMeta(findReplaceKey, { type: "setQuery", query, options: resolved } satisfies FindMeta),
  );
  gotoFindMatch(editor, 0);
}

/** 跳到第 index 个命中（越界自动回绕），并选中它 */
export function gotoFindMatch(editor: Editor, index: number) {
  if (editor.isDestroyed) return;
  const st = getFindState(editor);
  if (!st || st.matches.length === 0) return;
  const n = st.matches.length;
  const i = ((index % n) + n) % n;
  const m = st.matches[i];
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "setActive", index: i } satisfies FindMeta));
  editor.chain().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
}

/** 当前匹配是否为空查询（空查询不允许替换，避免"把所有位置删掉"） */
function replaceable(st: FindState | null): st is FindState {
  return !!st && st.query !== "" && st.matches.length > 0 && st.active >= 0;
}

/** 文档编辑后的重算：命中数变化时把活动项夹回范围内 */
function recomputeMatches(state: FindState, doc: ProseMirrorNode): FindState {
  const scan = scanMatches(doc, state.query, state.options);
  const active = scan.matches.length === 0 ? -1 : Math.min(Math.max(state.active, 0), scan.matches.length - 1);
  return { ...state, matches: scan.matches, active, truncated: scan.truncated, invalid: scan.invalid };
}

/** 正则档的替换串走 JS 语义：`$1`、`$&`、`$$` 这些按当前命中展开；表达式已失效时原样替换 */
function expandReplacement(st: FindState, doc: ProseMirrorNode, match: FindMatch, replacement: string): string {
  if (!st.options.regex) return replacement;
  try {
    const re = new RegExp(st.query, st.options.caseSensitive ? "" : "i");
    return doc.textBetween(match.from, match.to, "\n").replace(re, replacement);
  } catch {
    return replacement;
  }
}

/** 替换前/替换后强制同步重算：位置全变或可能吃到延迟窗口内的旧命中，等不起尾抖动 */
export function recomputeFindNow(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "recompute" } satisfies FindMeta));
}

/** 替换当前选中的命中（替换后停在下一个命中） */
export function replaceActiveMatch(editor: Editor, replacement: string): boolean {
  if (editor.isDestroyed) return false;
  // 延迟窗口内可能还挂着旧命中：先同步重算，避免按旧位置误替换
  recomputeFindNow(editor);
  const st = getFindState(editor);
  if (!replaceable(st)) return false;
  const m = st.matches[st.active];
  const value = expandReplacement(st, editor.state.doc, m, replacement);
  const chain = editor.chain().focus();
  if (value === "") chain.deleteRange({ from: m.from, to: m.to });
  else chain.insertContentAt({ from: m.from, to: m.to }, value);
  chain.run();
  // 替换后所有命中位置都变了：立即重算，after 才是新位置
  recomputeFindNow(editor);
  const after = getFindState(editor);
  if (after && after.matches.length > 0) gotoFindMatch(editor, after.active);
  return true;
}

/** 全部替换：一条事务从后往前替换，前面的位置不受影响；返回替换处数 */
export function replaceAllMatches(editor: Editor, replacement: string): number {
  if (editor.isDestroyed) return 0;
  recomputeFindNow(editor);
  const st = getFindState(editor);
  if (!replaceable(st)) return 0;
  const count = st.matches.length;
  const chain = editor.chain().focus();
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const m = st.matches[i];
    // 逐个命中各自展开捕获组：从后往前落，前面的位置与文本都不受已替换部分影响
    const value = expandReplacement(st, editor.state.doc, m, replacement);
    if (value === "") chain.deleteRange({ from: m.from, to: m.to });
    else chain.insertContentAt({ from: m.from, to: m.to }, value);
  }
  chain.run();
  recomputeFindNow(editor);
  return count;
}

/**
 * 就地替换整篇文档里的所有命中，绕开 MAX_MATCHES 上限分批续跑（全局替换用，不挂查找栏状态）。
 * 与 replaceAllMatches 的区别：
 *   - 不读 FindState，因此不会影响页面上正在用的查找高亮，也不依赖「当前命中」下标；
 *   - 与 JSON 层全局替换（lib/text-replace.ts）保持同一条保护规则——首个标题块是页面标题
 *     （由 views.name 权威管理），落在保护区里的命中一律不动；
 *   - 一轮最多消化 MAX_MATCHES 个命中，剩下的立即重扫继续，直到没有命中或跑满轮次上限。
 * 每轮是一条独立事务，用户仍能用 Ctrl+Z 逐轮回退。返回替换处数。
 */
export function replaceAllInDoc(
  editor: Editor,
  query: string,
  replacement: string,
  options: FindOptions = {},
  maxRounds = MAX_REPLACE_ROUNDS,
): number {
  if (editor.isDestroyed || !query) return 0;
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const doc = editor.state.doc;
    const guard = protectedHeadingEnd(doc);
    const scan = scanMatches(doc, query, options);
    const hits = scan.matches.filter((m) => m.from >= guard);
    if (hits.length === 0) break;
    const tr = editor.state.tr;
    // 从后往前落：前面的命中位置不受已替换部分影响；保护区之后的跨块命中也一并跳过
    for (let i = hits.length - 1; i >= 0; i--) {
      const m = hits[i];
      if (m.from < guard) break;
      if (replacement === "") tr.delete(m.from, m.to);
      else tr.replaceWith(m.from, m.to, editor.state.schema.text(replacement));
    }
    if (!tr.docChanged) break;
    editor.view.dispatch(tr);
    total += hits.length;
    // 没触顶就说明这一轮已经吃完整篇命中；再扫一遍只会把「替换串里本就含查询词」
    // 的新文字当成新命中，越替换越多
    if (!scan.truncated) break;
  }
  return total;
}

/** 首个块是标题时它的右边界（页面标题保护区），否则 0 */
function protectedHeadingEnd(doc: ProseMirrorNode): number {
  const first = doc.firstChild;
  return first?.type.name === "heading" ? first.nodeSize : 0;
}

/** 预览用的可替换处数：与 replaceAllInDoc 共用保护区与匹配语义，只读不改文档。
 *  与替换一样受 MAX_MATCHES 约束，触顶时这里报的是「至少这么多」。 */
export function countReplaceableInDoc(editor: Editor, query: string, options: FindOptions = {}): number {
  if (editor.isDestroyed || !query) return 0;
  const guard = protectedHeadingEnd(editor.state.doc);
  return scanMatches(editor.state.doc, query, options).matches.filter((m) => m.from >= guard).length;
}

export function clearFind(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "clear" } satisfies FindMeta));
}

function applyMeta(state: FindState, tr: Transaction, meta: FindMeta): FindState {
  if (meta.type === "clear")
    return { query: "", options: NO_OPTIONS, matches: [], active: -1, truncated: false, invalid: false };
  if (meta.type === "setQuery") {
    const scan = scanMatches(tr.doc, meta.query, meta.options);
    return {
      query: meta.query,
      options: meta.options,
      matches: scan.matches,
      active: scan.matches.length > 0 ? 0 : -1,
      truncated: scan.truncated,
      invalid: scan.invalid,
    };
  }
  if (meta.type === "recompute") return recomputeMatches(state, tr.doc);
  const n = state.matches.length;
  if (n === 0) return state;
  return { ...state, active: ((meta.index % n) + n) % n };
}

export const FindReplace = Extension.create({
  name: "findReplace",

  addProseMirrorPlugins() {
    // 延迟重算的挂起定时器与本编辑器的视图（每个编辑器实例一份）：
    // 文档编辑（打字的每个按键）不再同步全量重扫，改走尾抖动；替换流程用 recomputeFindNow 立即兜底
    let recomputeTimer: number | null = null;
    let viewRef: EditorView | null = null;
    const cancelPending = () => {
      if (recomputeTimer !== null) {
        window.clearTimeout(recomputeTimer);
        recomputeTimer = null;
      }
    };
    const scheduleRecompute = () => {
      cancelPending();
      recomputeTimer = window.setTimeout(() => {
        recomputeTimer = null;
        const view = viewRef;
        if (!view) return;
        view.dispatch(view.state.tr.setMeta(findReplaceKey, { type: "recompute" } satisfies FindMeta));
      }, RECOMPUTE_DELAY);
    };

    return [
      new Plugin<FindState>({
        key: findReplaceKey,
        state: {
          init: () => ({
            query: "",
            options: NO_OPTIONS,
            matches: [],
            active: -1,
            truncated: false,
            invalid: false,
          }),
          apply(tr, prev) {
            const meta = tr.getMeta(findReplaceKey) as FindMeta | undefined;
            if (meta) {
              // 显式重算（含替换流程的同步兜底）：撤销挂起的延迟任务，避免重复扫描
              if (meta.type === "recompute") cancelPending();
              return applyMeta(prev, tr, meta);
            }
            if (!tr.docChanged || prev.query === "") return prev;
            // 延迟期间沿用旧命中（位置可能短暂漂移），150ms 后统一重扫
            scheduleRecompute();
            return prev;
          },
        },
        view: (view) => {
          viewRef = view;
          return {
            destroy() {
              viewRef = null;
              cancelPending();
            },
          };
        },
        props: {
          decorations(state) {
            const st = findReplaceKey.getState(state);
            if (!st || st.matches.length === 0) return null;
            return DecorationSet.create(
              state.doc,
              st.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === st.active ? "find-hit find-hit-active" : "find-hit",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
