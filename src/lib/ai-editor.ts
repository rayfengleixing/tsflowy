// AI 助手 ↔ 编辑器桥接：面板需要「取当前页纯文本 / 取选中文本 / 用文本替换选区 /
// 在光标处插入 / 按标题或原文定位改写」，但 AI 面板与 EditorPage 是兄弟节点，无法用 props 传递 editor 实例。
// 参照 lib/close-flush.ts 的注册/桥接范式：EditorPage 挂载时注册实现，AI 面板按需读取。
// 分栏时只注册主栏（与 useEditorStore 推送 editor 的约定一致），避免副栏抢占回填目标。

import type { AiEditAnchor, AiEditOp } from "./ai-edit";

/**
 * 编辑指令的落地结果。
 * applied 为假表示没写成（没有目标 / 结构锁定拦掉了事务 / 锚点没找到）；
 * reason 是失败原因（i18n key 或直接文案），供界面展示；
 * revert 是撤销句柄，里面存着改之前的文档快照。
 */
export interface AiEditApplyResult {
  applied: boolean;
  reason?: string;
  revert?: AiEditRevert;
}

/**
 * 撤销句柄（不透明）。只在产生它的那个编辑器实例里有效，跨页面/跨重启一律失效，
 * 因此不参与会话持久化（见 stores/ai.ts 的 sanitizeMessage）。
 */
export interface AiEditRevert {
  readonly before: unknown;
}

export interface AiEditorBridge {
  /** 当前文档纯文本（块之间用换行连接） */
  getPageText: () => string;
  /** 当前文档标题（未命名时为空串） */
  getPageTitle: () => string;
  /** 当前选区纯文本；未选中返回空串 */
  getSelectionText: () => string;
  /**
   * 某类编辑指令即将改动的原文（用于落地前的 diff 预览）。
   * replace_selection 返回选区文本；replace_text 返回命中的原文；其余插入/追加类返回空串。
   */
  getEditTargetText: (op: AiEditOp, anchor?: AiEditAnchor) => string;
  /** 用文本替换当前选区（无选区时等价于在光标处插入） */
  replaceSelection: (text: string) => void;
  /** 在光标处插入文本 */
  insertAtCursor: (text: string) => void;
  /**
   * 应用 AI 下发的编辑指令（依据 op 决定作用范围，定位类 op 用 anchor 找目标）。
   * 返回落地结果：applied 表示真的改了文档，revert 供 undoAiEdit 精确回滚。
   */
  applyEdit: (op: AiEditOp, markdown: string, anchor?: AiEditAnchor) => AiEditApplyResult;
  /**
   * 精确回滚一次 AI 编辑。
   * 直接 editor.undo() 会撤销「最后一次改动」——若 AI 改完之后用户自己又编辑过，
   * 那一步撤的是用户的操作，界面却显示「已撤销本次修改」，属于静默破坏用户内容。
   * 这里先 undo 一次并与改前快照比对：一致才算成功；不一致立刻 redo 复原并返回 false。
   */
  undoAiEdit: (revert: AiEditRevert | undefined) => boolean;
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
