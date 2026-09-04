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
  setEditor: (editor, viewId) => set({ editor, currentViewId: viewId || null }),
}));
