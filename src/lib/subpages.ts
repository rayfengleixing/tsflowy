// 子页面双链列表：纯逻辑层
//
// 需求：父文档正文「最上方」自动列出所有子页面的双链（[[子页面]]），
// 子页面新建 / 重命名 / 删除 / 移动时随之更新。
//
// 设计：
//   · 父文档里只放一个 subpages 原子块（紧跟在结构锁定的「首行 H1 + 分割线」之后），
//     块内 items 保存子页面 id + 名称快照；
//   · 该块由 workspace store 在页面树变化时统一维护（见 stores/workspace.ts）；
//   · 块的 NodeView 渲染时优先读取实时页面树，因此重命名 / 删除即使快照短暂滞后也不会显示错；
//   · items 同时被 mentions 反链索引采集，使「父 → 子」也构成真正的双链。
//
// 所有函数都是纯函数，便于 Vitest 单测（与 daily-notes.ts 同思路）。
import type { JSONContent } from "@tiptap/core";

/** 子页面链接块的节点类型名（与 extensions/subpages/node.ts 保持一致） */
export const SUBPAGES_NODE = "subpages";

export interface SubpageItem {
  id: string;
  name: string;
}

/** 子页面链接块节点 */
export function subpagesNode(items: SubpageItem[]): JSONContent {
  return { type: SUBPAGES_NODE, attrs: { items } };
}

/** 从块级节点数组中读取子页面项（无块 / 数据损坏时返回空数组） */
export function readSubpagesItems(doc: JSONContent): SubpageItem[] {
  const node = (doc.content ?? []).find((n) => n.type === SUBPAGES_NODE);
  const raw: unknown = node?.attrs?.items;
  if (!Array.isArray(raw)) return [];
  const out: SubpageItem[] = [];
  for (const it of raw as unknown[]) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    if (typeof rec.id !== "string") continue;
    out.push({ id: rec.id, name: typeof rec.name === "string" ? rec.name : "" });
  }
  return out;
}

/**
 * 头部保护区（首行 H1 + 可选的分割线）之后的插入下标；
 * 首行不是 H1（非文档页 / 空文档）时返回 -1，表示无处可放。
 */
export function subpagesAnchorIndex(content: JSONContent[]): number {
  if (content.length === 0) return -1;
  const first = content[0];
  if (first.type !== "heading" || (first.attrs?.level ?? 1) !== 1) return -1;
  return content[1]?.type === "horizontalRule" ? 2 : 1;
}

/**
 * 维护父文档里的子页面链接块：先删掉全部旧块，再在头部保护区之后放入一个新块。
 * · items 为空 → 只做移除；
 * · 没有首行 H1 → 原样返回；
 * · 内容无变化 → 返回同一个 doc 引用（调用方可据此跳过落库）。
 */
export function upsertSubpagesNode(doc: JSONContent, items: SubpageItem[]): JSONContent {
  const content = doc.content ?? [];
  const anchor = subpagesAnchorIndex(content);
  if (anchor < 0) return doc;

  const stripped = content.filter((n) => n.type !== SUBPAGES_NODE);
  const next =
    items.length === 0 ? stripped : [...stripped.slice(0, anchor), subpagesNode(items), ...stripped.slice(anchor)];

  if (JSON.stringify(next) === JSON.stringify(content)) return doc;
  return { ...doc, content: next };
}
