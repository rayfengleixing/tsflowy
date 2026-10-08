// 全局 editor 实例共享 store（Phase 3.1）
//
// 设计动机：旧版 DocumentOutline 由 EditorPage 通过 props 传入 editor，但大纲面板
// 迁移到侧栏页签后，Sidebar 与 EditorPage 是兄弟节点，无法通过 props 传递 editor 实例。
// 改为通过 Zustand 全局 store 共享：EditorPage 创建 editor 后调用 setEditor 推送；
// Sidebar 中的 OutlineTab 通过 useEditorStore(s => s.editor) 读取。
//
// 同时持有 currentViewId，便于侧栏判断当前激活的视图（避免 outline tab 在非文档视图渲染）。
import { create } from "zustand";
import type { Editor } from "@tiptap/react";

interface EditorStoreState {
  editor: Editor | null;
  currentViewId: string | null;
  /** 推送（或清空）全局 editor 实例。EditorPage 挂载时调用，卸载时传 null。 */
  setEditor: (editor: Editor | null, viewId: string | null) => void;
}

export const useEditorStore = create<EditorStoreState>()((set) => ({
  editor: null,
  currentViewId: null,
  setEditor: (editor, viewId) => set({ editor, currentViewId: viewId ?? null }),
}));

// ————— 文档编辑器登记表：按 viewId 索引所有存活的编辑器实例 —————
//
// 与上面的 store 不同（store 只持有主栏那一个），这里登记全部面板（含分栏副栏）。
// 用途：需要"就地更新打开中的文档"的逻辑（如子页面块维护）必须找到每一个正打开该
// 文档的编辑器；只改主栏会漏掉副栏，副栏随后的自动保存会把就地更新覆盖掉。
// 用模块级 Map 而非 zustand state：登记表只在事件回调里读取，不需要驱动渲染。

const docEditors = new Map<string, Set<Editor>>();

/** 登记一个存活的文档编辑器实例；返回注销函数 */
export function registerDocEditor(viewId: string, editor: Editor): () => void {
  let set = docEditors.get(viewId);
  if (!set) {
    set = new Set();
    docEditors.set(viewId, set);
  }
  set.add(editor);
  return () => {
    const entries = docEditors.get(viewId);
    if (!entries) return;
    entries.delete(editor);
    if (entries.size === 0) docEditors.delete(viewId);
  };
}

/** 取某视图当前打开着的编辑器实例（同一文档可能同时开在两栏） */
export function getDocEditors(viewId: string): Editor[] {
  const set = docEditors.get(viewId);
  return set ? [...set] : [];
}
