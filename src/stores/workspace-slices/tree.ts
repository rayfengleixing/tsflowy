import { buildTree, flattenTree } from "@/lib/tree";
import { viewApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { newSelectOption } from "@/lib/database-values";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { canonicalTagName } from "@/lib/tags";
import { mentionsApi } from "@/lib/mentions";
import type { JSONContent } from "@tiptap/core";
import type { View, ViewNode } from "@/types/models";
import type { SubpageItem } from "@/lib/subpages";
import { loadTabsForWs, persistNow } from "./persistence";
import { applySubpagesToParent, backfillSubpages } from "./subpages-sync";
import type { WorkspaceGet, WorkspaceSet, WorkspaceSliceCreator, WorkspaceState } from "./types";

/** 树内查找节点（跨模块复用：first-heading-lock 按视图 id 取最新名称） */
export function findInTree(nodes: ViewNode[], id: string): ViewNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findInTree(n.children, id);
    if (found) return found;
  }
  return null;
}

/** 递归更新树中某个节点的 icon（避免全量 reload，提升响应速度） */
function patchTreeIcon(tree: ViewNode[], id: string, icon: string | null): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, icon };
    if (node.children.length > 0) return { ...node, children: patchTreeIcon(node.children, id, icon) };
    return node;
  });
}

/** 递归更新树中某个节点的 name */
function patchTreeName(tree: ViewNode[], id: string, name: string): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, name };
    if (node.children.length > 0) return { ...node, children: patchTreeName(node.children, id, name) };
    return node;
  });
}

/** 递归更新树中某个节点的部分字段（icon/name/tags/is_favorite 等浅字段） */
export function patchTreeView(tree: ViewNode[], id: string, patch: Partial<View>): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, ...patch };
    if (node.children.length > 0) return { ...node, children: patchTreeView(node.children, id, patch) };
    return node;
  });
}

/** Grid 默认字段 + 空行（名称/日期/单选；单选预置两个选项，日期供日历视图使用，单选供看板视图使用） */
async function seedGridFields(viewId: string): Promise<void> {
  await databaseApi.createField(viewId, "text", t("field.exampleName"));
  await databaseApi.createField(viewId, "date", t("field.exampleDate"));
  const select = await databaseApi.createField(viewId, "single_select", t("field.exampleSelect"));
  await databaseApi.updateFieldOptions(select.id, {
    kind: "select",
    options: [newSelectOption(t("field.exampleOption", { n: 1 })), newSelectOption(t("field.exampleOption", { n: 2 }))],
  });
  await databaseApi.createRow(viewId);
}

// 树加载是异步的：晚到的响应可能属于已切走的空间（或已被更新的请求），只允许最新一次写入。
// 没有它时快速切空间/连续刷新会让旧空间的树盖住新空间的树。
let treeSeq = 0;

async function patchTree(set: WorkspaceSet, get: WorkspaceGet): Promise<void> {
  const { currentWorkspaceId } = get();
  if (!currentWorkspaceId) return;
  const seq = ++treeSeq;
  const [views, trash] = await Promise.all([
    viewApi.listByWorkspace(currentWorkspaceId),
    viewApi.listTrash(currentWorkspaceId),
  ]);
  if (seq !== treeSeq || get().currentWorkspaceId !== currentWorkspaceId) return;
  const tree = buildTree(views);
  // 只保留 tree 中真实存在（未被删/移走）的 tabs，按原顺序
  const byId = new Map<string, ViewNode>();
  for (const n of flattenTree(tree)) byId.set(n.id, n);
  const tabs = get()
    .tabs.map((v) => byId.get(v.id))
    .filter(Boolean) as ViewNode[];
  let currentViewId = get().currentViewId;
  if (currentViewId && !byId.has(currentViewId)) currentViewId = tabs[0]?.id ?? null;
  // 副视图（并排对照）对应的页面若已被删/移走，一并取消并排
  let splitViewId = get().splitViewId;
  if (splitViewId && !byId.has(splitViewId)) splitViewId = null;
  set({ tree, trash, tabs, currentViewId, splitViewId });
  persistNow(get);
  void backfillSubpages(get, currentWorkspaceId);
}

// patchTree 的变体：调用 loadTabsForWs 从 app_settings 恢复（首次进入 workspace）
export async function patchTreeAndRestoreTabs(set: WorkspaceSet, get: WorkspaceGet): Promise<void> {
  const { currentWorkspaceId } = get();
  if (!currentWorkspaceId) return;
  const seq = ++treeSeq;
  const [views, trash] = await Promise.all([
    viewApi.listByWorkspace(currentWorkspaceId),
    viewApi.listTrash(currentWorkspaceId),
  ]);
  const tree = buildTree(views);
  const { tabs, currentViewId } = await loadTabsForWs(currentWorkspaceId, tree);
  if (seq !== treeSeq || get().currentWorkspaceId !== currentWorkspaceId) return;
  set({ tree, trash, tabs, currentViewId, splitViewId: null });
  persistNow(get);
  void backfillSubpages(get, currentWorkspaceId);
}

/** 把 parentId 下的子页面同步进父文档最上方的双链块（无子页面则移除该块） */
export function syncSubpages(get: WorkspaceGet, parentId: string | null): void {
  if (!parentId) return;
  const parent = findInTree(get().tree, parentId);
  if (!parent) return;
  const items: SubpageItem[] = parent.children.map((c) => ({ id: c.id, name: c.name }));
  void applySubpagesToParent(parentId, items);
}

export const createTreeSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  tree: [],

  reload: async () => {
    await patchTree(set, get);
  },

  createView: async ({ parentId, layout }) => {
    const ws = get().currentWorkspaceId;
    if (!ws) return null;
    const name = t("common.untitled");
    const view = await viewApi.create({
      workspace_id: ws,
      parent_id: parentId,
      name,
      layout,
    });
    if (layout === "grid") {
      // Grid 预置默认字段（名称/数字/单选）+ 一个空行（项目说明书 5.1）
      try {
        await seedGridFields(view.id);
      } catch (e) {
        logger.error("WorkspaceStore.createView", "seed grid fields failed", view.id, e);
      }
    }
    await get().reload();
    set({ expanded: new Set(get().expanded).add(parentId ?? "") });
    // 先同步父页面的子页面块：父页若正开着，这一步还赶得上就地改编辑器（打开子页会卸载它）
    syncSubpages(get, parentId);
    get().openView(view.id);
    return view;
  },

  duplicateView: async (id) => {
    const node = findInTree(get().tree, id);
    if (!node) return;
    const { view, documents } = await viewApi.duplicate(id, t("tree.duplicateName", { name: node.name }));
    // 副本正文里的 @提及 按保存路径同样重建反链索引；单篇失败不阻断整次复制
    for (const doc of documents) {
      try {
        await mentionsApi.rebuildFor(doc.view_id, JSON.parse(doc.content) as JSONContent);
      } catch (e) {
        logger.warn("WorkspaceStore.duplicateView", "rebuild mentions skipped", doc.view_id, e);
      }
    }
    await get().reload();
    set({ expanded: new Set(get().expanded).add(node.parent_id ?? "") });
    // 与 createView 同理：先同步父页面（父页正开着时能就地改编辑器），再打开副本
    syncSubpages(get, node.parent_id);
    // 副本自身的「子页面」块也要重建：Rust 复制正文时块里还挂着原树的子页 id，
    // 副本的子页已换成新 id，这里按新树重写（副本尚未打开，走库读改写路径）
    syncSubpages(get, view.id);
    get().openView(view.id);
  },

  renameView: async (id: string, name: string) => {
    await viewApi.rename(id, name);
    set((state) => ({
      tabs: state.tabs.map((v) => (v.id === id ? { ...v, name } : v)),
      tree: patchTreeName(state.tree, id, name),
    }));
    // 名称是对应「父页面」子页面块里的链接文案，需要同步刷新
    syncSubpages(get, findInTree(get().tree, id)?.parent_id ?? null);
  },

  setViewIcon: async (id: string, icon: string | null) => {
    await viewApi.setIcon(id, icon);
    set((state) => ({
      tabs: state.tabs.map((v) => (v.id === id ? { ...v, icon } : v)),
      tree: patchTreeIcon(state.tree, id, icon),
    }));
  },

  setViewFavorite: async (id: string, favorite: boolean) => {
    await viewApi.setFavorite(id, favorite);
    set((state) => ({ tree: patchTreeView(state.tree, id, { is_favorite: favorite ? 1 : 0 }) }));
  },

  setViewTags: async (id: string, tags: string[]) => {
    // 落库取规范形并去重：同一逻辑标签只存一种写法（"工作 / 项目A" → "工作/项目A"）
    const normalized = [...new Set(tags.map(canonicalTagName).filter(Boolean))];
    await viewApi.setTags(id, normalized);
    set((state) => ({ tree: patchTreeView(state.tree, id, { tags: JSON.stringify(normalized) }) }));
  },

  deleteView: async (id: string) => {
    const parentId = findInTree(get().tree, id)?.parent_id ?? null;
    await viewApi.softDelete(id);
    // 关闭该视图及全部后代的标签页
    const node = findInTree(get().tree, id);
    const affected = node ? new Set(flattenTree([node]).map((n) => n.id)) : new Set([id]);
    const tabs = get().tabs.filter((v) => !affected.has(v.id));
    const current = get().currentViewId;
    const currentViewId = current && affected.has(current) ? (tabs[tabs.length - 1]?.id ?? null) : current;
    const split = get().splitViewId;
    const splitViewId = split && affected.has(split) ? null : split;
    set({ tabs, currentViewId, splitViewId });
    await get().reload();
    syncSubpages(get, parentId);
  },

  restoreView: async (id: string) => {
    await viewApi.restore(id);
    await get().reload();
    syncSubpages(get, findInTree(get().tree, id)?.parent_id ?? null);
  },

  purgeView: async (id: string) => {
    // 永久删除前记下父页：删掉的子页要从父页「子页面」块里消失
    const parentId = findInTree(get().tree, id)?.parent_id ?? null;
    await viewApi.purge(id);
    await get().reload();
    syncSubpages(get, parentId);
  },

  moveView: async (viewId, newParentId, index) => {
    const oldParentId = findInTree(get().tree, viewId)?.parent_id ?? null;
    await viewApi.move(viewId, newParentId, index);
    await get().reload();
    syncSubpages(get, oldParentId);
    if (newParentId !== oldParentId) syncSubpages(get, newParentId);
  },
});
