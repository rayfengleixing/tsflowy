import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import { documentApi } from "@/lib/documents";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
import { viewApi } from "@/lib/db";
import { upsertSubpagesNode, type SubpageItem } from "@/lib/subpages";
import { getDocEditors } from "../editor";
import type { WorkspaceGet } from "./types";

/* ————— 子页面双链块：把「父页面 → 子页面」的链接列表维护在父文档正文最上方 ————— */

/** 头部保护区（首行 H1 + 可选分割线）之后的 ProseMirror 绝对位置；无首行 H1 返回 -1 */
function subpagesPosInPmDoc(doc: ProseMirrorNode): number {
  if (doc.childCount === 0) return -1;
  const first = doc.child(0);
  if (first.type.name !== "heading" || (first.attrs as { level: number }).level !== 1) return -1;
  let pos = first.nodeSize;
  if (doc.childCount > 1 && doc.child(1).type.name === "horizontalRule") pos += doc.child(1).nodeSize;
  return pos;
}

/** 在已打开的父文档编辑器里就地更新子页面块（走正常自动保存）；成功返回 true */
export function applySubpagesInEditor(editor: Editor, items: SubpageItem[]): boolean {
  const { state } = editor;
  const type = state.schema.nodes.subpages as NodeType | undefined;
  if (!type) return false;

  let existingPos: number | null = null;
  let existingSize = 0;
  let offset = 0;
  for (let i = 0; i < state.doc.childCount; i++) {
    const child = state.doc.child(i);
    if (child.type.name === "subpages") {
      existingPos = offset;
      existingSize = child.nodeSize;
      break;
    }
    offset += child.nodeSize;
  }

  if (items.length === 0) {
    if (existingPos === null) return true;
    editor.view.dispatch(state.tr.delete(existingPos, existingPos + existingSize));
    return true;
  }
  if (existingPos !== null) {
    editor.view.dispatch(state.tr.setNodeMarkup(existingPos, undefined, { items }));
    return true;
  }
  const pos = subpagesPosInPmDoc(state.doc);
  if (pos < 0) return false;
  editor.view.dispatch(state.tr.insert(pos, type.create({ items })));
  return true;
}

/**
 * 把子页面列表写进父文档：父页开着编辑器（主栏或分栏任一面板）时就地改
 * （避免与编辑器内存态互相覆盖），否则读库改写再落库。父页没有正文（表格 / 看板 / 日历页）时跳过。
 */
export async function applySubpagesToParent(parentId: string, items: SubpageItem[]): Promise<void> {
  const liveEditors = getDocEditors(parentId).filter((ed) => !ed.isDestroyed);
  if (liveEditors.length > 0) {
    // 就地更新每一个打开着父页的编辑器实例（覆盖主栏 + 分栏副栏），随各自的自动保存落库
    let applied = false;
    for (const ed of liveEditors) {
      if (applySubpagesInEditor(ed, items)) applied = true;
    }
    if (applied) return;
  }
  let raw: string | null;
  try {
    raw = await documentApi.get(parentId);
  } catch (e) {
    logger.warn("WorkspaceStore", "read parent doc for subpages failed", parentId, e);
    return;
  }
  if (!raw) return;
  let doc: JSONContent;
  try {
    doc = JSON.parse(raw) as JSONContent;
  } catch (e) {
    logger.warn("WorkspaceStore", "parse parent doc for subpages failed", parentId, e);
    return;
  }
  const next = upsertSubpagesNode(doc, items);
  if (next === doc) return; // 无变化不落库
  try {
    await documentApi.save(parentId, JSON.stringify(next));
  } catch (e) {
    logger.warn("WorkspaceStore", "write subpages block failed", parentId, e);
  }
}

/* ————— 子页面块补齐：老数据里已有父子关系但正文没有列表，每个空间补一次 ————— */

/** 补齐版本：逻辑有变化（例如新增要覆盖的页型）时递增 */
const SUBPAGES_BACKFILL_VERSION = "1";
const subpagesBackfillKey = (wsId: string) => `tsflowy:subpages-backfill:${wsId}`;
/** 本进程内已补齐过的空间，避免每次 reload 都读一次 app_settings */
const backfilledWs = new Set<string>();

/**
 * 给「有子页面但正文里还没有列表」的文档页补上子页面块。
 * 每日笔记的「每日笔记 / 年份 / 月份」三级目录页也走这条路径（它们就是普通文档页）。
 * 表格 / 看板 / 日历页没有正文，applySubpagesToParent 会自行跳过。
 */
export async function backfillSubpages(get: WorkspaceGet, wsId: string): Promise<void> {
  if (backfilledWs.has(wsId)) return;
  backfilledWs.add(wsId);
  try {
    if ((await viewApi.getSetting(subpagesBackfillKey(wsId))) === SUBPAGES_BACKFILL_VERSION) return;
    for (const node of flattenTree(get().tree)) {
      if (node.children.length === 0) continue;
      await applySubpagesToParent(
        node.id,
        node.children.map((c) => ({ id: c.id, name: c.name })),
      );
    }
    await viewApi.setSetting(subpagesBackfillKey(wsId), SUBPAGES_BACKFILL_VERSION);
  } catch (e) {
    logger.warn("WorkspaceStore", "backfill subpages failed", wsId, e);
  }
}
