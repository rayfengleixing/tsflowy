import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { findInTree, useWorkspaceStore } from "@/stores/workspace";
import { logger } from "@/lib/logger";

/**
 * FirstHeadingLock TipTap 扩展（B-2 接入）。
 *
 * 把「文档首 H1 文本」同步为 view.name，避免 TabBar/顶栏/面包屑
 * 长时间显示"无标题页面"。只在用户编辑产生新 H1 内容时写入。
 * 注：结构锁定后 H1 不可编辑，名称权威源为 view.name（EditorPage
 * 重命名时反向同步 H1，见 document-structure-lock 的 STRUCTURE_SYNC_META）；
 * 本扩展仅兜底历史文档中未被锁定的 H1 变化。
 */

interface LockStorage {
  lastText: string;
  lastViewId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  pending: { id: string; text: string } | null;
}

/** 每按键一次 renameView 就是一次 IPC + 落库 + 树刷新 → 合并到静止后再写 */
const RENAME_DEBOUNCE_MS = 400;

export const FirstHeadingLock = Extension.create<{ viewId: string | null }, LockStorage>({
  name: "firstHeadingLock",

  addOptions() {
    return {
      viewId: null as string | null,
    };
  },

  // 状态必须按编辑器实例隔离：主副栏打开不同页面时，模块级共享变量会互相
  // 覆盖 lastSync，且实例销毁时会把「另一个实例」刚排队的改名误冲刷进库。
  addStorage() {
    return { lastText: "", lastViewId: null, timer: null, pending: null };
  },

  onCreate() {
    syncOnce(this.storage, this.editor, this.options.viewId);
  },
  onUpdate() {
    syncOnce(this.storage, this.editor, this.options.viewId);
  },
  onDestroy() {
    // 卸载（切视图/关标签）前把待写的重命名落下去，否则最后一次输入会丢
    flushRename(this.storage);
  },
});

function syncOnce(
  storage: LockStorage,
  ctx: { isDestroyed: boolean; state?: { doc?: ProseMirrorNode } },
  viewId: string | null,
) {
  if (ctx.isDestroyed) return;
  const doc = ctx.state?.doc;
  if (!doc) return;
  const firstH1 = findFirstHeading1(doc);
  if (!firstH1) return;
  const text = firstH1.textContent.trim();
  if (!text) return;
  if (!viewId) return;
  if (storage.lastViewId === viewId && storage.lastText === text) return;
  storage.lastViewId = viewId;
  storage.lastText = text;
  storage.pending = { id: viewId, text };
  if (storage.timer) clearTimeout(storage.timer);
  storage.timer = setTimeout(() => flushRename(storage), RENAME_DEBOUNCE_MS);
}

/** 微任务里写库，避免在 Tiptap 同步回调中触发 store 变更引起循环 */
function flushRename(storage: LockStorage) {
  if (storage.timer) {
    clearTimeout(storage.timer);
    storage.timer = null;
  }
  const pending = storage.pending;
  storage.pending = null;
  if (!pending) return;
  queueMicrotask(() => {
    const store = useWorkspaceStore.getState();
    // 按"被改名的视图"查最新名称：原实现用根级 tree.find 且比对当前打开视图的
    // currentViewId，嵌套页/分栏副栏场景都会拿错参照，导致改名结果与库不一致
    const current = findInTree(store.tree, pending.id);
    const vName = current?.name ?? "";
    if (pending.text === vName) return;
    store
      .renameView(pending.id, pending.text)
      .catch((e: unknown) => logger.error("FirstHeadingLock", "rename failed", pending.id, pending.text, e));
  });
}

function findFirstHeading1(doc: ProseMirrorNode): ProseMirrorNode | null {
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === "heading" && (child.attrs as { level: number }).level === 1) {
      return child;
    }
  }
  return null;
}
