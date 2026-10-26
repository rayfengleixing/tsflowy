// 页面引用（id / 标题 / 别名）→ 树节点：AI 侧所有「用户说的到底是哪一页」的解析都走这里，
// 匹配不到或有歧义一律返回 null，绝不猜——猜错改的是用户的数据。

import { appTree } from "../app-context";
import { flattenTree } from "../tree";
import { parseViewAliases, type ViewNode } from "@/types/models";

/**
 * 页面引用（id、标题或别名）→ 树节点；匹配不到或歧义时返回 null，绝不猜。
 * 标题优先于别名：`计划书` 既是某页的名字又是另一页的别名时，叫这个名字的那页才是用户要的。
 */
export function resolvePage(ref: string): ViewNode | null {
  const list = flattenTree(appTree());
  if (!ref) return null;
  const byId = list.find((v) => v.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const eq = (name: string) => name.trim().toLowerCase() === wanted;
  const byTitle = list.filter((v) => eq(v.name));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) return null; // 两页同名，本来就无从判断
  const byAlias = list.filter((v) => parseViewAliases(v.aliases).some(eq));
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) return null;
  const namesOf = (v: ViewNode) => [v.name, ...parseViewAliases(v.aliases)].map((n) => n.trim().toLowerCase());
  const fuzzy = list.filter((v) => namesOf(v).some((n) => n.includes(wanted)));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}
