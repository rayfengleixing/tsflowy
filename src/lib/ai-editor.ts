// AI 助手 ↔ 编辑器桥接：面板需要「取当前页纯文本 / 取选中文本 / 用文本替换选区 /
// 在光标处插入」，但 AI 面板与 EditorPage 是兄弟节点，无法用 props 传递 editor 实例。
// 参照 lib/close-flush.ts 的注册/桥接范式：EditorPage 挂载时注册实现，AI 面板按需读取。
// 分栏时只注册主栏（与 useEditorStore 推送 editor 的约定一致），避免副栏抢占回填目标。

import type { AiEditOp } from "./ai-edit";

export interface AiEditorBridge {
  /** 当前文档纯文本（块之间用换行连接） */
  getPageText: () => string;
  /** 当前文档标题（未命名时为空串） */
  getPageTitle: () => string;
  /** 当前选区纯文本；未选中返回空串 */
  getSelectionText: () => string;
  /** 用文本替换当前选区（无选区时等价于在光标处插入） */
  replaceSelection: (text: string) => void;
  /** 在光标处插入文本 */
  insertAtCursor: (text: string) => void;
  /**
   * 应用 AI 下发的编辑指令（依据 op 决定作用范围）。
   * 成功写入返回 true；没有可用目标或转换失败返回 false。
   */
  applyEdit: (op: AiEditOp, markdown: string) => boolean;
  /** 撤销上一次文档改动（等价于 Ctrl+Z），用于给自动改写兜底 */
  undo: () => void;
}

let current: AiEditorBridge | null = null;

/** 注册当前文档编辑器桥接；返回注销函数（仅当自己仍是当前注册项时才清空） */
export function registerAiEditor(bridge: AiEditorBridge): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

/** 取当前注册的编辑器桥接；没有打开中的文档时返回 null */
export function getAiEditor(): AiEditorBridge | null {
  return current;
}
