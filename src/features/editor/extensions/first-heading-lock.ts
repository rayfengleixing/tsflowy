import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useWorkspaceStore } from "@/stores/workspace";
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
export const FirstHeadingLock = Extension.create({
  name: "firstHeadingLock",

  addOptions() {
    return {
      viewId: null as string | null,
    };
  },

  onCreate() {
    syncOnce(this);
  },
  onUpdate() {
    syncOnce(this);
  },
});

let lastSyncText = "";
let lastSyncViewId: string | null = null;

function syncOnce(ctx: {
  editor: { isDestroyed: boolean; state?: { doc?: ProseMirrorNode } };
  options: { viewId: string | null };
}) {
  const { editor, options } = ctx;
  if (editor.isDestroyed) return;
  const doc = editor.state?.doc;
  if (!doc) return;
  const firstH1 = findFirstHeading1(doc);
  if (!firstH1) return;
  const text = firstH1.textContent.trim();
  if (!text) return;
  const id = options.viewId;
  if (!id) return;
  if (lastSyncViewId === id && lastSyncText === text) return;
  lastSyncViewId = id;
  lastSyncText = text;
  // 微任务：避免在 Tiptap 同步回调中 dispatch 引起循环
  queueMicrotask(() => {
    if (editor.isDestroyed) return;
    const store = useWorkspaceStore.getState();
    const current = store.currentViewId ? store.tree.find((v) => v.id === store.currentViewId) : null;
    const vName = current?.name ?? "";
    if (text === vName) return;
    store.renameView(id, text).catch((e) => logger.error("FirstHeadingLock", "rename failed", id, text, e));
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
