// 上层运行态的单点（依赖倒置）：lib 要读的（语言/页面树/当前页/编辑器）、要做的（刷树、改名、
// 开页、跳界面、失效关联、定位行、订阅工作区变化、订阅语言变化）都在这里声明，
// stores 在自己的模块体里把实现绑进来。
//
// 为什么要这层：lib 里曾有 19 处 `useXxxStore.getState()`，跑得通，痛在不可测——每个消费模块的用例
// 都要 vi.mock 掉整条 store 才起得来，store 字段一改，lib 就跟着悄悄错位；分层方向也反了
// （本该 features → stores → lib → types）。注册/注销的形制沿用 lib/close-flush.ts 与 lib/ai-editor.ts。
//
// 兜底口径是分开定的，不是一律回空值：
//   · 语言有合理默认（注册表首项）——启动早期、纯 node 用例都可能还没绑，取默认最多少翻译一句，
//     不该在 t() 这种全仓消费点上抛；
//   · 页面树、当前空间、当前页、编辑器实例没有合理默认：把「还没绑」当成「没有页面」会让整目录导出
//     静默返回 0 行、让 AI 工具回「页面不存在」，那是最难查的一类假象，所以未绑定直接抛；
//   · 写侧同理：没有「合理的默认动作」可回落，未绑定一律抛，且指名缺哪一项（action()），
//     不让少绑一项的用例靠 undefined 的 TypeError 去猜；
//   · 语言订阅（subscribeLang）也一样不回落：退化成「读一次值」的 appLang() 看着能用，
//     切语言后界面不重渲染，属于最难发现的一类失效。
//
// 写侧为什么也收在这里而不是另起一个 service 模块：`vi.mock("@/stores/workspace")` 这类整条 store
// 替身会把 store 的字段形状焊进用例（改名就一片红）；绑 action 只声明「要做什么」，用例侧
// 用 src/test/app-fakes.ts 登记假动作即可。
import { useSyncExternalStore } from "react";
import type { ViewNode } from "@/types/models";
import { LANGUAGES, type LangCode } from "./i18n/languages";

export interface AppReaders {
  /** 当前界面语言 */
  getLang: () => LangCode;
  /** 当前空间的页面树（未加载时为空数组，由绑定方原样给） */
  getTree: () => ViewNode[];
  /** 当前工作区 id；没选空间时为 null */
  getCurrentWorkspaceId: () => string | null;
  /** 当前打开的页面 id（AI 未指定父页面时挂在它下面）；没有打开的页时为 null */
  getCurrentViewId: () => string | null;
  /**
   * 当前文档的编辑器（长图/PDF 导出要读活的 DOM）。这里刻意写成结构最小集而不是引 tiptap 的
   * Editor 类型：本模块只被「读哪两三个字段」约束，换编辑器实现不该牵动它（同 lib/ai-editor.ts 的做法）。
   */
  getEditor: () => AppEditor | null;
}

/** 导出用得到的编辑器最小面：判断还活着 + 拿到正文 DOM */
export interface AppEditor {
  readonly isDestroyed: boolean;
  readonly view: { readonly dom: HTMLElement };
}

/** lib 侧会跳的界面：只登记真用得到的那一个，绑定方与 stores 的 Route 不兼容时 tsc 立刻报 */
export type AppRoute = "settings";

/** 写侧动作登记表（字段名与 store 里的同名动作对齐，读代码时不用换脑子） */
export interface AppActions {
  /** 重新拉当前空间的页面树（建页/软删之后必须刷，否则界面还是旧的） */
  reload: () => Promise<void>;
  /** 改页面标题：走 store 那条链（写库 + 刷树 + 失效关联），不是裸改一行数据 */
  renameView: (viewId: string, name: string) => Promise<void>;
  /** 打开页面：与用户点侧栏同一条路径（建 Tab、记访问时间、落盘） */
  openView: (viewId: string) => void;
  /** 切顶层界面 */
  setRoute: (route: AppRoute) => void;
  /** 让某些库的关联/反向关系快照失效（绕开 database store 的写入口时得手动补） */
  invalidateRelations: (viewIds: string[]) => void;
  /** 表格视图滚动并高亮某一行 */
  setFocusRow: (rowId: string) => void;
  /** 工作区状态变化时回调（深链要在页面树里出现目标页之后才跳转）；返回取消函数 */
  subscribeWorkspace: (listener: () => void) => () => void;
  /**
   * 语言变化时回调；返回取消函数。为什么这里收的是订阅而不是 hook：
   * `useLanguage()` 要在切换语言后让整棵树重渲染，注册表能注入的是「取值函数」和「动作」，
   * 把 React 的 hook 当普通值传来传去本身就是 react-compiler 拦的那类写法；
   * 所以 hook 由本模块自己组（下面的 useAppLang 用 useSyncExternalStore），stores 只给订阅这一半。
   */
  subscribeLang: (listener: () => void) => () => void;
}

/** 分项绑定：settings 绑语言与它的订阅、workspace 绑树与写动作、relation/row-focus/editor 各绑自己那项 */
export type AppReadersBinding = Partial<AppReaders>;
export type AppActionsBinding = Partial<AppActions>;

/** 与 stores/settings.ts 的 loadLang 回落同一口径：注册表首项为默认语言 */
const DEFAULT_LANG = LANGUAGES[0].code;

let readers: AppReadersBinding = {};
let actions: AppActionsBinding = {};

/** stores 侧在模块求值时调用一次；返回的注销函数供测试 afterEach 复位（同 close-flush 的形制） */
export function bindAppReaders(next: AppReadersBinding): () => void {
  const prev = readers;
  readers = { ...readers, ...next };
  return () => {
    readers = prev;
  };
}

/** 写侧绑定，形制与 bindAppReaders 相同 */
export function bindAppActions(next: AppActionsBinding): () => void {
  const prev = actions;
  actions = { ...actions, ...next };
  return () => {
    actions = prev;
  };
}

/** 回到「谁都没绑」的状态：不给默认实现，避免上一个用例的假读取漏给下一个 */
export function resetAppReaders(): void {
  readers = {};
}

export function resetAppActions(): void {
  actions = {};
}

export function appLang(): LangCode {
  return readers.getLang ? readers.getLang() : DEFAULT_LANG;
}

function need<K extends keyof AppReaders>(key: K, value: AppReaders[K] | undefined): NonNullable<AppReaders[K]> {
  if (!value) throw new Error(`app-context：${key} 还没有绑定，需由 stores 侧调 bindAppReaders`);
  return value;
}

/** 未绑定就抛，并指名缺哪一项 */
function action<K extends keyof AppActions>(key: K): AppActions[K] {
  const value = actions[key];
  if (!value) throw new Error(`app-context：${key} 还没有绑定，需由 stores 侧调 bindAppActions`);
  return value;
}

export function appTree(): ViewNode[] {
  return need("getTree", readers.getTree)();
}

export function appWorkspaceId(): string | null {
  return need("getCurrentWorkspaceId", readers.getCurrentWorkspaceId)();
}

export function appViewId(): string | null {
  return need("getCurrentViewId", readers.getCurrentViewId)();
}

export function appEditor(): AppEditor | null {
  return need("getEditor", readers.getEditor)();
}

export function appReload(): Promise<void> {
  return action("reload")();
}

export function appRenameView(viewId: string, name: string): Promise<void> {
  return action("renameView")(viewId, name);
}

export function appOpenView(viewId: string): void {
  action("openView")(viewId);
}

export function appSetRoute(route: AppRoute): void {
  action("setRoute")(route);
}

export function appInvalidateRelations(viewIds: string[]): void {
  action("invalidateRelations")(viewIds);
}

export function appSetFocusRow(rowId: string): void {
  action("setFocusRow")(rowId);
}

export function appSubscribeWorkspace(listener: () => void): () => void {
  return action("subscribeWorkspace")(listener);
}

/**
 * 当前语言的 React 订阅：stores 只给「怎么订阅」（AppActions.subscribeLang），
 * hook 本身在这里用 useSyncExternalStore 组，读的仍是 appLang() 那一份。
 * 未绑定直接抛，不回落成「读一次值」——那种实现看着能用，切语言后界面不重渲染，是最难发现的一类失效。
 * 比的是语言这个快照，所以改别的设置项不会连累订阅方重渲染（与直接 useSettingsStore((s) => s.lang) 同口径）。
 */
export function useAppLang(): LangCode {
  return useSyncExternalStore(action("subscribeLang"), appLang, appLang);
}
