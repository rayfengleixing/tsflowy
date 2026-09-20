// 文档内查找替换（Ctrl+F）
//
// 纯逻辑放这里，UI 见 features/editor/FindReplaceBar.tsx：
//   - 命中按块收集：把每个文本块的文本片段映射回文档位置，跨 mark 的命中也能整段选中；
//   - 高亮走 decoration（不改文档），活动项单独上色；
//   - 替换/全部替换用一条事务从后往前落，位置不互相污染。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";

export const findReplaceKey = new PluginKey<FindState>("findReplace");

/** 命中数上限：单字符查询在长文里会出几千个 decoration，超出部分不参与高亮 */
const MAX_MATCHES = 1000;

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  matches: FindMatch[];
  /** 当前命中下标；无命中为 -1 */
  active: number;
}

type FindMeta = { type: "setQuery"; query: string } | { type: "setActive"; index: number } | { type: "clear" };

/** 文本块内 "文本偏移 → 文档位置" 的映射片（只统计文本字符，原子 inline 节点不占文本偏移） */
interface Piece {
  docPos: number;
  textStart: number;
  len: number;
}

export function collectMatches(doc: ProseMirrorNode, query: string): FindMatch[] {
  const out: FindMatch[] = [];
  if (!query) return out;
  const needle = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent.toLowerCase();
    if (!text.includes(needle)) return false;
    const pieces: Piece[] = [];
    let textStart = 0;
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) return;
      pieces.push({ docPos: pos + 1 + offset, textStart, len: child.text.length });
      textStart += child.text.length;
    });
    const toDocPos = (offset: number): number => {
      let hit = pieces[0];
      for (const p of pieces) {
        if (offset >= p.textStart) hit = p;
        else break;
      }
      return hit.docPos + (offset - hit.textStart);
    };
    let idx = text.indexOf(needle);
    while (idx !== -1 && out.length < MAX_MATCHES) {
      out.push({ from: toDocPos(idx), to: toDocPos(idx + needle.length) });
      idx = text.indexOf(needle, idx + needle.length);
    }
    return false; // 命中已在块内收集完，不再下钻子节点
  });
  return out;
}

export function getFindState(editor: Editor): FindState | null {
  return findReplaceKey.getState(editor.state) ?? null;
}

/** 设置查询词并自动跳到首个命中 */
export function setFindQuery(editor: Editor, query: string) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "setQuery", query } satisfies FindMeta));
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

/** 替换当前选中的命中（替换后停在下一个命中） */
export function replaceActiveMatch(editor: Editor, replacement: string): boolean {
  if (editor.isDestroyed) return false;
  const st = getFindState(editor);
  if (!replaceable(st)) return false;
  const m = st.matches[st.active];
  const chain = editor.chain().focus();
  if (replacement === "") chain.deleteRange({ from: m.from, to: m.to });
  else chain.insertContentAt({ from: m.from, to: m.to }, replacement);
  chain.run();
  const after = getFindState(editor);
  if (after && after.matches.length > 0) gotoFindMatch(editor, after.active);
  return true;
}

/** 全部替换：一条事务从后往前替换，前面的位置不受影响；返回替换处数 */
export function replaceAllMatches(editor: Editor, replacement: string): number {
  if (editor.isDestroyed) return 0;
  const st = getFindState(editor);
  if (!replaceable(st)) return 0;
  const count = st.matches.length;
  const chain = editor.chain().focus();
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const m = st.matches[i];
    if (replacement === "") chain.deleteRange({ from: m.from, to: m.to });
    else chain.insertContentAt({ from: m.from, to: m.to }, replacement);
  }
  chain.run();
  return count;
}

export function clearFind(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "clear" } satisfies FindMeta));
}

function applyMeta(state: FindState, tr: Transaction, meta: FindMeta): FindState {
  if (meta.type === "clear") return { query: "", matches: [], active: -1 };
  if (meta.type === "setQuery") {
    const matches = collectMatches(tr.doc, meta.query);
    return { query: meta.query, matches, active: matches.length > 0 ? 0 : -1 };
  }
  const n = state.matches.length;
  if (n === 0) return state;
  return { ...state, active: ((meta.index % n) + n) % n };
}

export const FindReplace = Extension.create({
  name: "findReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findReplaceKey,
        state: {
          init: () => ({ query: "", matches: [], active: -1 }),
          apply(tr, prev) {
            const meta = tr.getMeta(findReplaceKey) as FindMeta | undefined;
            if (meta) return applyMeta(prev, tr, meta);
            if (!tr.docChanged || prev.query === "") return prev;
            // 文档编辑后重算：命中数变化时把活动项夹回范围内
            const matches = collectMatches(tr.doc, prev.query);
            const active = matches.length === 0 ? -1 : Math.min(Math.max(prev.active, 0), matches.length - 1);
            return { ...prev, matches, active };
          },
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
