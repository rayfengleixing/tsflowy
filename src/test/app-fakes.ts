import { vi, type Mock } from "vitest";
import type { LangCode } from "@/lib/i18n/languages";
import type { ViewNode } from "@/types/models";

import {
  bindAppActions,
  bindAppReaders,
  resetAppActions,
  resetAppReaders,
  type AppActions,
  type AppEditor,
} from "@/lib/app-context";

/** 假运行态的可变部分：绑进注册表的是取值函数，改用例时直接改这里就能让 lib 侧读到新值 */
export interface FakeAppState {
  lang: LangCode;
  tree: ViewNode[];
  workspaceId: string | null;
  viewId: string | null;
  editor: AppEditor | null;
}

/** 每个动作换成同名 vi.fn，签名跟 AppActions 对齐，断言时不用猜参数 */
export type FakeAppActions = { [K in keyof AppActions]: Mock<AppActions[K]> };

export interface FakeApp {
  state: FakeAppState;
  /** 写侧与订阅动作的替身（与 AppActions 逐键对齐）：断言「有没有打到这一步」直接用它们 */
  actions: FakeAppActions;
  /** 触发一次「工作区变了」，让 lib 侧注册的订阅回调跑起来（深链排队那条路） */
  emitWorkspaceChange: () => void;
  /** 触发一次「语言变了」，驱动 useAppLang 的订阅方重渲染 */
  emitLangChange: () => void;
  /** 只改关心的那几项读取值 */
  set: (next: Partial<FakeAppState>) => void;
  dispose: () => void;
}

/**
 * 把 lib 侧的运行态一次绑齐，替掉 `vi.mock("@/stores/…")` 那种整条 store 替身。
 * 默认「中文 + 空树 + 没选空间 + 没有打开页 + 无编辑器 + 所有动作只记账不做事」；
 * 用例通过 `set()` 换读到的值、通过 `actions.xxx` 断言打没打到、`emitWorkspaceChange()` 模拟 store 变化。
 */
export function bindFakeApp(initial: Partial<FakeAppState> = {}): FakeApp {
  const state: FakeAppState = {
    lang: "zh-CN",
    tree: [],
    workspaceId: null,
    viewId: null,
    editor: null,
    ...initial,
  };
  const listeners: (() => void)[] = [];
  const langListeners: (() => void)[] = [];
  let disposed = false;
  const actions: FakeAppActions = {
    reload: vi.fn((): Promise<void> => Promise.resolve()),
    renameView: vi.fn((): Promise<void> => Promise.resolve()),
    openView: vi.fn(),
    setRoute: vi.fn(),
    invalidateRelations: vi.fn(),
    setFocusRow: vi.fn(),
    subscribeWorkspace: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
    subscribeLang: vi.fn((listener: () => void) => {
      langListeners.push(listener);
      return () => {
        const i = langListeners.indexOf(listener);
        if (i >= 0) langListeners.splice(i, 1);
      };
    }),
  };

  const undoReaders = bindAppReaders({
    getLang: () => state.lang,
    getTree: () => state.tree,
    getCurrentWorkspaceId: () => state.workspaceId,
    getCurrentViewId: () => state.viewId,
    getEditor: () => state.editor,
  });
  const undoActions = bindAppActions(actions);

  return {
    state,
    actions,
    emitWorkspaceChange: () => {
      for (const listener of [...listeners]) listener();
    },
    emitLangChange: () => {
      for (const listener of [...langListeners]) listener();
    },
    set: (next) => {
      Object.assign(state, next);
    },
    // 幂等：用例里主动提前解绑（比如验「没绑就抛」）时，afterEach 再 dispose 一次不该把
    // 上一个用例的快照回滚回去。
    dispose: () => {
      if (disposed) return;
      disposed = true;
      undoActions();
      undoReaders();
      resetAppActions();
      resetAppReaders();
      listeners.length = 0;
      langListeners.length = 0;
    },
  };
}

/**
 * 够 export-page 用的最小编辑器替身：它只读 isDestroyed 与 view.dom。
 * 只想验「实例不可用就拒」的用例传 `{}` 即可（那条路径碰不到 DOM）；真要渲染才传 jsdom 元素。
 */
export function fakeEditor(dom: Partial<HTMLElement>, isDestroyed = false): AppEditor {
  return { isDestroyed, view: { dom: dom as HTMLElement } };
}
