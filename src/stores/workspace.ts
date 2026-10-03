import { create } from "zustand";
import type { LayoutType, View, ViewNode, Workspace } from "@/types/models";
import { parseViewTags } from "@/types/models";
import {
  TAG_META_KEY,
  canonicalTagName,
  omitTagColor,
  parseTagColors,
  renameTagColor,
  renameTagPath,
  tagMatchesFilter,
  type TagColorMap,
} from "@/lib/tags";
import { viewApi, workspaceApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { documentApi } from "@/lib/documents";
import { newSelectOption } from "@/lib/database-values";
import { buildTree, flattenTree } from "@/lib/tree";
import { useSettingsStore } from "./settings";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { buildWelcomeDoc, welcomeDocTitle } from "@/lib/welcome-doc";
import {
  buildDailyFolderDoc,
  buildDailyNoteDoc,
  dailyNoteNameMatches,
  dailyNoteTitle,
  loadDailyNotesConfig,
  toDateKey,
} from "@/lib/daily-notes";
import { mentionsApi } from "@/lib/mentions";
import { upsertSubpagesNode, type SubpageItem } from "@/lib/subpages";
import { getDocEditors } from "./editor";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";

export type Route = "workspace" | "trash" | "search" | "settings";

interface WorkspaceState {
  ready: boolean;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  tree: ViewNode[];
  trash: View[];
  tabs: View[]; // 当前空间打开的标签页（含顺序）
  currentViewId: string | null;
  /** 并排对照：右侧副视图 id（null = 未拆分）；主视图仍是 currentViewId */
  splitViewId: string | null;
  /** 并排左右宽度比例：左栏占比（0.25~0.75） */
  splitRatio: number;
  route: Route;
  /** 搜索结果页当前查询词 */
  searchQuery: string;
  expanded: Set<string>;
  sidebarWidth: number;

  init: () => Promise<void>;
  reload: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;

  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  setWorkspaceIcon: (id: string, icon: string | null) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  createView: (opts: { parentId: string | null; layout: LayoutType }) => Promise<View | null>;
  /** 复制页面整棵子树（子页面、正文、属性、数据库数据），副本排在同级末尾并自动打开 */
  duplicateView: (id: string) => Promise<void>;
  renameView: (id: string, name: string) => Promise<void>;
  setViewIcon: (id: string, icon: string | null) => Promise<void>;
  /** 收藏/取消收藏（侧边栏收藏区） */
  setViewFavorite: (id: string, favorite: boolean) => Promise<void>;
  /** 设置页面标签（整体覆写） */
  setViewTags: (id: string, tags: string[]) => Promise<void>;
  deleteView: (id: string) => Promise<void>;
  restoreView: (id: string) => Promise<void>;
  purgeView: (id: string) => Promise<void>;
  purgeTrash: () => Promise<void>;
  moveView: (viewId: string, newParentId: string | null, index: number) => Promise<void>;

  /** 页面树标签过滤：null = 不过滤 */
  tagFilter: string | null;
  setTagFilter: (tag: string | null) => void;

  /** 标签颜色表（全局，跨空间共用；未配置的标签用稳定默认色） */
  tagMeta: TagColorMap;
  loadTagMeta: () => Promise<void>;
  /** 设置标签颜色 */
  setTagColor: (tag: string, color: string) => Promise<void>;
  /** 全局重命名标签：更新所有带该标签的页面与颜色表 */
  renameTag: (from: string, to: string) => Promise<void>;
  /** 全局删除标签：从所有页面移除并清掉颜色配置 */
  deleteTag: (tag: string) => Promise<void>;

  openView: (id: string) => void;
  closeTab: (id: string) => void;
  /** 关闭所有标签页 */
  closeAllTabs: () => void;
  /** 关闭除指定标签外的其它标签页（保留的标签置为当前页） */
  closeOtherTabs: (id: string) => void;
  /** 在右侧分栏打开（并排对照）；已在并排时替换右侧 */
  openInSplit: (id: string) => void;
  closeSplit: () => void;
  /** 左右两栏互换 */
  swapSplit: () => void;
  setSplitRatio: (r: number) => void;
  newTab: () => Promise<void>;
  /** 打开某天的每日笔记（不存在则按模板创建）；date 省略 = 今天 */
  openDailyNote: (date?: Date) => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setRoute: (route: Route) => void;
  /** 打开搜索结果页 */
  openSearch: (query: string) => void;
  /** Ctrl+K 命令面板开关 */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  toggleExpand: (id: string) => void;
  expand: (id: string) => void;
  setExpandedAll: (ids: Set<string>) => void;
  setSidebarWidth: (w: number) => void;
}

let initPromise: Promise<void> | null = null;

/** 30 天回收站自动清空定时器：全局只建一次；每小时扫一次，跨空间清理 */
let autoPurgeTimer: ReturnType<typeof setInterval> | null = null;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

const TABS_KEY = (wsId: string) => `ui:tabs:${wsId}`;
const CURRENT_KEY = (wsId: string) => `ui:current_view:${wsId}`;

/** 标签页/当前视图写回 app_settings 的 300ms 去抖（避免每次 closeTab/reorderTabs 写 DB） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPendingWs: string | null = null;
let persistPendingTabs: string[] | null = null;
let persistPendingCurrent: string | null | undefined = undefined; // undefined=未变化；null=清空

/** 每日笔记打开串行队列：并发触发（连点、多入口同时调）会各自走一遍「查或建目录」，撞出重复目录页 */
let dailyNoteQueue: Promise<void> = Promise.resolve();

function schedulePersistUi(wsId: string, tabIds: string[], currentViewId: string | null) {
  persistPendingWs = wsId;
  persistPendingTabs = tabIds;
  persistPendingCurrent = currentViewId;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const wsId2 = persistPendingWs;
    const tabs2 = persistPendingTabs;
    const cur2 = persistPendingCurrent;
    persistTimer = null;
    persistPendingWs = null;
    persistPendingTabs = null;
    persistPendingCurrent = undefined;
    if (!wsId2 || !tabs2) return;
    void (async () => {
      try {
        await viewApi.setSetting(TABS_KEY(wsId2), JSON.stringify(tabs2));
        if (cur2 !== undefined) {
          if (cur2 === null) {
            await viewApi.setSetting(CURRENT_KEY(wsId2), "");
          } else {
            await viewApi.setSetting(CURRENT_KEY(wsId2), cur2);
          }
        }
      } catch (e) {
        logger.warn("WorkspaceStore", "persist tabs failed", wsId2, e);
      }
    })();
  }, 300);
}

/** 立即把挂起的 tabs/current 写回 app_settings（切换空间与关窗前冲刷共用），无挂起时快速返回 */
export async function flushPendingUiPersist(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const wsId = persistPendingWs;
  const tabs = persistPendingTabs;
  const cur = persistPendingCurrent;
  persistPendingWs = null;
  persistPendingTabs = null;
  persistPendingCurrent = undefined;
  if (!wsId || !tabs) return;
  try {
    await viewApi.setSetting(TABS_KEY(wsId), JSON.stringify(tabs));
    if (cur !== undefined) {
      await viewApi.setSetting(CURRENT_KEY(wsId), cur ?? "");
    }
  } catch (e) {
    logger.warn("WorkspaceStore", "flush pending tabs failed", wsId, e);
  }
}

async function loadTabsForWs(wsId: string, tree: ViewNode[]): Promise<{ tabs: View[]; currentViewId: string | null }> {
  try {
    const [tabsRaw, curRaw] = await Promise.all([
      viewApi.getSetting(TABS_KEY(wsId)),
      viewApi.getSetting(CURRENT_KEY(wsId)),
    ]);
    const ids: string[] = tabsRaw ? (JSON.parse(tabsRaw) as string[]) : [];
    const byId = new Map<string, ViewNode>();
    for (const n of flattenTree(tree)) byId.set(n.id, n);
    const tabs = ids.map((i) => byId.get(i)).filter(Boolean) as ViewNode[];
    let currentViewId = curRaw ?? null;
    if (currentViewId && !byId.has(currentViewId)) currentViewId = null;
    // 若持久化中没有 current，但 tabs 有，默认第一个
    if (!currentViewId && tabs.length > 0) currentViewId = tabs[0].id;
    return { tabs, currentViewId };
  } catch (e) {
    logger.warn("WorkspaceStore", "load tabs failed", wsId, e);
    return { tabs: [], currentViewId: null };
  }
}

const purgeAllExpiredTrash = async (): Promise<void> => {
  const workspaces = useWorkspaceStore.getState().workspaces;
  if (workspaces.length === 0) return;
  const now = Date.now();
  const deadline = now - THIRTY_DAYS_MS;
  for (const ws of workspaces) {
    try {
      await viewApi.purgeExpiredTrash(ws.id, deadline);
    } catch (e) {
      logger.error("WorkspaceStore", "auto purge expired trash failed", ws.id, e);
    }
  }
  // 如果当前 workspace 的 trash 列表在 store，重新 reload 刷新 UI
  const ws = useWorkspaceStore.getState().currentWorkspaceId;
  if (ws) await useWorkspaceStore.getState().reload();
};

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
function patchTreeView(tree: ViewNode[], id: string, patch: Partial<View>): ViewNode[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, ...patch };
    if (node.children.length > 0) return { ...node, children: patchTreeView(node.children, id, patch) };
    return node;
  });
}

/** 把标签颜色表写回 app_settings（全局键，失败仅告警，不影响 UI） */
async function persistTagMeta(meta: TagColorMap): Promise<void> {
  try {
    await viewApi.setSetting(TAG_META_KEY, JSON.stringify(meta));
  } catch (e) {
    logger.warn("WorkspaceStore", "persist tag meta failed", e);
  }
}

/* ————— 子页面双链块：把「父页面 → 子页面」的链接列表维护在父文档正文最上方 ————— */

/** 头部保护区（首行 H1 + 可选分割线）之后的 ProseMirror 绝对位置；无首行 H1 返回 -1 */
function subpagesPosInPmDoc(doc: ProseMirrorNode): number {
  if (doc.childCount === 0) return -1;
  const first = doc.child(0);
  if (first.type.name !== "heading" || (first.attrs as { level: number }).level !== 1) return -1;
  let pos = first.nodeSize;
  if (doc.childCount > 1 && doc.child(1).type.name === "horizontalRule") pos += doc.child(1).nodeSize;
  return pos;
}

/** 在已打开的父文档编辑器里就地更新子页面块（走正常自动保存）；成功返回 true */
function applySubpagesInEditor(editor: Editor, items: SubpageItem[]): boolean {
  const { state } = editor;
  const type = state.schema.nodes.subpages as NodeType | undefined;
  if (!type) return false;

  let existingPos: number | null = null;
  let existingSize = 0;
  let offset = 0;
  for (let i = 0; i < state.doc.childCount; i++) {
    const child = state.doc.child(i);
    if (child.type.name === "subpages") {
      existingPos = offset;
      existingSize = child.nodeSize;
      break;
    }
    offset += child.nodeSize;
  }

  if (items.length === 0) {
    if (existingPos === null) return true;
    editor.view.dispatch(state.tr.delete(existingPos, existingPos + existingSize));
    return true;
  }
  if (existingPos !== null) {
    editor.view.dispatch(state.tr.setNodeMarkup(existingPos, undefined, { items }));
    return true;
  }
  const pos = subpagesPosInPmDoc(state.doc);
  if (pos < 0) return false;
  editor.view.dispatch(state.tr.insert(pos, type.create({ items })));
  return true;
}

/**
 * 把子页面列表写进父文档：父页开着编辑器（主栏或分栏任一面板）时就地改
 * （避免与编辑器内存态互相覆盖），否则读库改写再落库。父页没有正文（表格 / 看板 / 日历页）时跳过。
 */
async function applySubpagesToParent(parentId: string, items: SubpageItem[]): Promise<void> {
  const liveEditors = getDocEditors(parentId).filter((ed) => !ed.isDestroyed);
  if (liveEditors.length > 0) {
    // 就地更新每一个打开着父页的编辑器实例（覆盖主栏 + 分栏副栏），随各自的自动保存落库
    let applied = false;
    for (const ed of liveEditors) {
      if (applySubpagesInEditor(ed, items)) applied = true;
    }
    if (applied) return;
  }
  let raw: string | null;
  try {
    raw = await documentApi.get(parentId);
  } catch (e) {
    logger.warn("WorkspaceStore", "read parent doc for subpages failed", parentId, e);
    return;
  }
  if (!raw) return;
  let doc: JSONContent;
  try {
    doc = JSON.parse(raw) as JSONContent;
  } catch (e) {
    logger.warn("WorkspaceStore", "parse parent doc for subpages failed", parentId, e);
    return;
  }
  const next = upsertSubpagesNode(doc, items);
  if (next === doc) return; // 无变化不落库
  try {
    await documentApi.save(parentId, JSON.stringify(next));
  } catch (e) {
    logger.warn("WorkspaceStore", "write subpages block failed", parentId, e);
  }
}

/* ————— 欢迎文档：内容随版本更新，启动时按版本号刷新一次 ————— */

/** 欢迎文档生成版本：正文有更新时递增，老版本安装会在启动时替换成新版示范文档 */
const WELCOME_DOC_KEY = "tsflowy:welcome-doc-version";
const WELCOME_DOC_VERSION = "2";

/** 按版本号刷新欢迎文档；找不到同名根级文档（用户删了/改名了）时只记版本，不新建 */
async function refreshWelcomeDoc(wsId: string): Promise<void> {
  try {
    if ((await viewApi.getSetting(WELCOME_DOC_KEY)) === WELCOME_DOC_VERSION) return;
    const lang = useSettingsStore.getState().lang;
    const title = welcomeDocTitle(lang);
    const views = await viewApi.listByWorkspace(wsId);
    const target = views.find((v) => v.parent_id === null && v.layout === "document" && v.name === title);
    if (target) await documentApi.save(target.id, JSON.stringify(buildWelcomeDoc(lang)));
    await viewApi.setSetting(WELCOME_DOC_KEY, WELCOME_DOC_VERSION);
  } catch (e) {
    logger.warn("WorkspaceStore", "refresh welcome doc failed", e);
  }
}

/* ————— 子页面块补齐：老数据里已有父子关系但正文没有列表，每个空间补一次 ————— */

/** 补齐版本：逻辑有变化（例如新增要覆盖的页型）时递增 */
const SUBPAGES_BACKFILL_VERSION = "1";
const subpagesBackfillKey = (wsId: string) => `tsflowy:subpages-backfill:${wsId}`;
/** 本进程内已补齐过的空间，避免每次 reload 都读一次 app_settings */
const backfilledWs = new Set<string>();

/**
 * 给「有子页面但正文里还没有列表」的文档页补上子页面块。
 * 每日笔记的「每日笔记 / 年份 / 月份」三级目录页也走这条路径（它们就是普通文档页）。
 * 表格 / 看板 / 日历页没有正文，applySubpagesToParent 会自行跳过。
 */
async function backfillSubpages(wsId: string): Promise<void> {
  if (backfilledWs.has(wsId)) return;
  backfilledWs.add(wsId);
  try {
    if ((await viewApi.getSetting(subpagesBackfillKey(wsId))) === SUBPAGES_BACKFILL_VERSION) return;
    for (const node of flattenTree(useWorkspaceStore.getState().tree)) {
      if (node.children.length === 0) continue;
      await applySubpagesToParent(
        node.id,
        node.children.map((c) => ({ id: c.id, name: c.name })),
      );
    }
    await viewApi.setSetting(subpagesBackfillKey(wsId), SUBPAGES_BACKFILL_VERSION);
  } catch (e) {
    logger.warn("WorkspaceStore", "backfill subpages failed", wsId, e);
  }
}

type EqualityFn<T> = (a: T, b: T) => boolean;

/**
 * 扩展版 hook 类型：zustand v5 默认删除了第二参数（equalityFn）重载，
 * 项目沿用 v4 风格，这里显式声明三个调用重载 + StoreApi 静态方法，
 * 保证 selector 内 `s` 的 WorkspaceState 类型推断正常。
 */
interface UseWorkspaceStoreHook {
  (): WorkspaceState;
  <U>(selector: (s: WorkspaceState) => U): U;
  <U>(selector: (s: WorkspaceState) => U, equalityFn: EqualityFn<U>): U;
  getState: () => WorkspaceState;
  getInitialState: () => WorkspaceState;
  setState: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState> | WorkspaceState),
    replace?: boolean,
  ) => void;
  subscribe: (listener: (state: WorkspaceState, prevState: WorkspaceState) => void) => () => void;
}

const _useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  // 把 tabs + current 状态根据 ids 计算并 schedule 持久化（所有状态变更都走这个 helper 统一）
  const persistNow = () => {
    const { currentWorkspaceId, tabs, currentViewId } = get();
    if (!currentWorkspaceId) return;
    schedulePersistUi(
      currentWorkspaceId,
      tabs.map((v) => v.id),
      currentViewId,
    );
  };

  // 树加载是异步的：晚到的响应可能属于已切走的空间（或已被更新的请求），只允许最新一次写入。
  // 没有它时快速切空间/连续刷新会让旧空间的树盖住新空间的树。
  let treeSeq = 0;

  const patchTree = async (): Promise<void> => {
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
    persistNow();
    void backfillSubpages(currentWorkspaceId);
  };

  // patchTree 的变体：调用 loadTabsForWs 从 app_settings 恢复（首次进入 workspace）
  const patchTreeAndRestoreTabs = async (): Promise<void> => {
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
    persistNow();
    void backfillSubpages(currentWorkspaceId);
  };

  /** 把 parentId 下的子页面同步进父文档最上方的双链块（无子页面则移除该块） */
  const syncSubpages = (parentId: string | null): void => {
    if (!parentId) return;
    const parent = findInTree(get().tree, parentId);
    if (!parent) return;
    const items: SubpageItem[] = parent.children.map((c) => ({ id: c.id, name: c.name }));
    void applySubpagesToParent(parentId, items);
  };

  return {
    ready: false,
    workspaces: [],
    currentWorkspaceId: null,
    tree: [],
    trash: [],
    tabs: [],
    currentViewId: null,
    splitViewId: null,
    splitRatio: 0.5,
    route: "workspace",
    searchQuery: "",
    paletteOpen: false,
    expanded: new Set<string>(),
    sidebarWidth: 240,
    tagFilter: null,
    tagMeta: {},

    init: async () => {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          let workspaces = await workspaceApi.list();
          if (workspaces.length === 0) {
            // 首次启动种子数据：默认空间 + 欢迎文档（内容为全部功能的示例与使用说明）
            const lang = useSettingsStore.getState().lang;
            const wsName = t("workspace.defaultName");
            const ws = await workspaceApi.create(wsName);
            const welcome = await viewApi.create({
              workspace_id: ws.id,
              parent_id: null,
              name: welcomeDocTitle(lang),
              layout: "document",
            });
            await documentApi.save(welcome.id, JSON.stringify(buildWelcomeDoc(lang)));
            await viewApi.setSetting(WELCOME_DOC_KEY, WELCOME_DOC_VERSION);
            workspaces = await workspaceApi.list();
          }
          let current = await viewApi.getSetting("last_workspace_id");
          if (!current || !workspaces.some((w) => w.id === current)) {
            current = workspaces[0].id;
          }
          set({ workspaces, currentWorkspaceId: current, ready: true });
          await patchTreeAndRestoreTabs();
          await get().loadTagMeta();
          await refreshWelcomeDoc(current);
          // 首次启动展开根级页面
          set({
            expanded: new Set(
              get()
                .tree.filter((n) => n.children.length > 0)
                .map((n) => n.id),
            ),
          });
          // 30 天回收站自动清空：启动立即扫一次，然后每小时轮询
          if (autoPurgeTimer === null) {
            void purgeAllExpiredTrash();
            autoPurgeTimer = setInterval(() => {
              void purgeAllExpiredTrash();
            }, HOURLY_MS);
          }
        } catch (e) {
          logger.error("WorkspaceStore.init", "workspace init failed", e);
          // 修复 App 死循环：init 失败时**由 store 内部**最终保证 ready=true，
          // 避免 App.catch 外部再写一份 setState 引发 zustand selector 重判定触发 React 19 开发模式的快照检查。
          // ready 相同值短路（zustand 默认比较对象是整 state，这里字段本身已 true 时不会额外 emit）。
          if (!get().ready) set({ ready: true });
          throw e;
        }
      })();
      return initPromise;
    },

    reload: async () => {
      await patchTree();
    },

    switchWorkspace: async (id: string) => {
      if (id === get().currentWorkspaceId) return;
      // 切换前立即把旧空间的 tabs 持久化（不等 300ms，避免丢失）
      await flushPendingUiPersist();

      set({ currentWorkspaceId: id, tabs: [], currentViewId: null, splitViewId: null });
      await viewApi.setSetting("last_workspace_id", id);
      await patchTreeAndRestoreTabs();
      // 展开新空间根级页面
      set({
        expanded: new Set(
          get()
            .tree.filter((n) => n.children.length > 0)
            .map((n) => n.id),
        ),
      });
    },

    createWorkspace: async (name: string) => {
      const ws = await workspaceApi.create(name);
      set({ workspaces: [...get().workspaces, ws] });
    },

    renameWorkspace: async (id: string, name: string) => {
      await workspaceApi.rename(id, name);
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      });
    },

    setWorkspaceIcon: async (id: string, icon: string | null) => {
      await workspaceApi.setIcon(id, icon);
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, icon } : w)),
      });
    },

    deleteWorkspace: async (id: string) => {
      await workspaceApi.remove(id);
      const workspaces = get().workspaces.filter((w) => w.id !== id);
      set({ workspaces });
      if (get().currentWorkspaceId === id) {
        const next = workspaces[0] ?? null;
        set({ currentWorkspaceId: next ? next.id : null, tabs: [], currentViewId: null, splitViewId: null });
        if (next) {
          await viewApi.setSetting("last_workspace_id", next.id);
          await get().reload();
        }
      }
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
      syncSubpages(parentId);
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
      syncSubpages(node.parent_id);
      // 副本自身的「子页面」块也要重建：Rust 复制正文时块里还挂着原树的子页 id，
      // 副本的子页已换成新 id，这里按新树重写（副本尚未打开，走库读改写路径）
      syncSubpages(view.id);
      get().openView(view.id);
    },

    renameView: async (id: string, name: string) => {
      await viewApi.rename(id, name);
      set((state) => ({
        tabs: state.tabs.map((v) => (v.id === id ? { ...v, name } : v)),
        tree: patchTreeName(state.tree, id, name),
      }));
      // 名称是对应「父页面」子页面块里的链接文案，需要同步刷新
      syncSubpages(findInTree(get().tree, id)?.parent_id ?? null);
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
      syncSubpages(parentId);
    },

    restoreView: async (id: string) => {
      await viewApi.restore(id);
      await get().reload();
      syncSubpages(findInTree(get().tree, id)?.parent_id ?? null);
    },

    purgeView: async (id: string) => {
      // 永久删除前记下父页：删掉的子页要从父页「子页面」块里消失
      const parentId = findInTree(get().tree, id)?.parent_id ?? null;
      await viewApi.purge(id);
      await get().reload();
      syncSubpages(parentId);
    },

    purgeTrash: async () => {
      const ws = get().currentWorkspaceId;
      if (!ws) return;
      // 被永久删除的页面，其"未被删除的父页"子页面块需要刷新（回收站列表 reload 后即清空）
      const trashedIds = new Set(get().trash.map((v) => v.id));
      const affectedParents = new Set<string>();
      for (const v of get().trash) {
        if (v.parent_id && !trashedIds.has(v.parent_id)) affectedParents.add(v.parent_id);
      }
      await viewApi.purgeTrash(ws);
      await get().reload();
      for (const pid of affectedParents) syncSubpages(pid);
    },

    moveView: async (viewId, newParentId, index) => {
      const oldParentId = findInTree(get().tree, viewId)?.parent_id ?? null;
      await viewApi.move(viewId, newParentId, index);
      await get().reload();
      syncSubpages(oldParentId);
      if (newParentId !== oldParentId) syncSubpages(newParentId);
    },

    openView: (id: string) => {
      const { tree, tabs } = get();
      const node = findInTree(tree, id);
      if (!node) return;
      let changed = false;
      let nextTabs = tabs;
      if (!tabs.some((v) => v.id === id)) {
        nextTabs = [...tabs, node];
        changed = true;
      }
      const cur = get().currentViewId;
      if (changed || cur !== id) {
        set({ tabs: nextTabs, currentViewId: id, route: "workspace" });
        persistNow();
      } else {
        set({ route: "workspace" });
      }
      // Phase 3.2：异步刷新 visited_at，不阻塞 UI（失败仅 warn，不影响打开流程）
      void viewApi.touchVisited(id).catch(logger.catch("WorkspaceStore.openView", "touchVisited failed", id));
    },

    closeTab: (id: string) => {
      const tabs = get().tabs.filter((v) => v.id !== id);
      let currentViewId = get().currentViewId;
      if (currentViewId === id) {
        const idx = get().tabs.findIndex((v) => v.id === id);
        currentViewId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      // 关掉的是副视图则取消并排
      const splitViewId = get().splitViewId === id ? null : get().splitViewId;
      set({ tabs, currentViewId, splitViewId });
      persistNow();
    },

    closeAllTabs: () => {
      set({ tabs: [], currentViewId: null, splitViewId: null });
      persistNow();
    },

    closeOtherTabs: (id) => {
      const keep = get().tabs.find((v) => v.id === id);
      if (!keep) return;
      // 保留的标签可能是右栏（副视图）：收敛为唯一标签并置为当前页
      set({ tabs: [keep], currentViewId: id, splitViewId: null });
      persistNow();
    },

    openInSplit: (id) => {
      const { tree, tabs, currentViewId } = get();
      const node = findInTree(tree, id);
      if (!node) return;
      // 还没有主视图时无从对照，退化为普通打开
      if (!currentViewId) {
        get().openView(id);
        return;
      }
      const nextTabs = tabs.some((v) => v.id === id) ? tabs : [...tabs, node];
      if (id === currentViewId) {
        // 想让当前页去右侧：把另一个标签提上来当主视图；只有这一个视图则不做
        const other = nextTabs.find((v) => v.id !== id);
        if (!other) return;
        set({ tabs: nextTabs, currentViewId: other.id, splitViewId: id, route: "workspace" });
      } else {
        set({ tabs: nextTabs, splitViewId: id, route: "workspace" });
      }
      persistNow();
      void viewApi.touchVisited(id).catch(logger.catch("WorkspaceStore.openInSplit", "touchVisited failed", id));
    },

    closeSplit: () => set({ splitViewId: null }),

    swapSplit: () => {
      const { currentViewId, splitViewId } = get();
      if (!currentViewId || !splitViewId) return;
      set({ currentViewId: splitViewId, splitViewId: currentViewId });
      persistNow();
    },

    setSplitRatio: (r) => set({ splitRatio: Math.min(0.75, Math.max(0.25, r)) }),

    newTab: async () => {
      await get().createView({ parentId: null, layout: "document" });
    },

    openDailyNote: async (date) => {
      // 串行排队：并发触发（连点、多入口同时调）会各自查/建一遍目录页，撞出重复目录
      const start = dailyNoteQueue;
      let release!: () => void;
      dailyNoteQueue = new Promise<void>((resolve) => (release = resolve));
      await start;
      try {
        const ws = get().currentWorkspaceId;
        if (!ws) return;
        const lang = useSettingsStore.getState().lang;
        const cfg = loadDailyNotesConfig();
        const dateKey = toDateKey(date ?? new Date());
        // 目录按 年/月 分级：<目录页>/<YYYY>/<MM>/<YYYY-MM-DD>，全部是普通文档页，
        // 无需额外标记：搜索/标签/导出/备份/同步一律按普通页面生效
        // （listByWorkspace 已排除行详情文档与派生视图，返回的都是树里的页面）
        const views = await viewApi.listByWorkspace(ws);

        // 找/建同名文档子页；新建时 seed 成「H1 + 分割线」的目录页文档（结构锁定要求首行 H1）
        const ensureFolder = async (parentId: string | null, name: string, intro = ""): Promise<View> => {
          const existing = views.find((v) => v.parent_id === parentId && v.layout === "document" && v.name === name);
          if (existing) return existing;
          const created = await viewApi.create({ workspace_id: ws, parent_id: parentId, name, layout: "document" });
          views.push(created);
          try {
            await documentApi.save(created.id, JSON.stringify(buildDailyFolderDoc(name, intro)));
          } catch (e) {
            // 正文种子失败不阻断：页面已建好，用户可直接写
            logger.warn("WorkspaceStore.openDailyNote", "seed folder doc failed", created.id, e);
          }
          return created;
        };

        const root = await ensureFolder(null, cfg.folderName, t("daily.folderIntro"));
        const year = await ensureFolder(root.id, dateKey.slice(0, 4));
        const month = await ensureFolder(year.id, dateKey.slice(5, 7));
        // 页面名形如「10-02 周五」：用「月-日」前缀 + 边界匹配，可跨语言切换复用同一天笔记
        // （旧命名 YYYY-MM-DD 前缀是年份不会命中；"10-025" 这类更长数字也不会误匹配）
        let note = views.find(
          (v) => v.parent_id === month.id && v.layout === "document" && dailyNoteNameMatches(v.name, dateKey),
        );
        if (!note) {
          note = await viewApi.create({
            workspace_id: ws,
            parent_id: month.id,
            name: dailyNoteTitle(dateKey, lang),
            layout: "document",
          });
          views.push(note);
          try {
            await documentApi.save(note.id, JSON.stringify(buildDailyNoteDoc(dateKey, cfg.template, lang)));
          } catch (e) {
            logger.warn("WorkspaceStore.openDailyNote", "seed note doc failed", note.id, e);
          }
        }
        const noteId = note.id;
        await get().reload();
        // 目录页与普通文档一样带「子页面」双链列表：每日笔记页列年份、年份页列月份、月份页列当月笔记。
        // 每次都按最新页面树整体重写，所以历史遗留的目录页也会被补齐。
        syncSubpages(root.id);
        syncSubpages(year.id);
        syncSubpages(month.id);
        // 展开要在同步之后：目录页若正开着，先就地改编辑器再打开笔记，避免卸载时把新列表覆盖掉
        // 逐级展开，保证当天笔记在树里可见
        const expanded = new Set(get().expanded);
        expanded.add(root.id);
        expanded.add(year.id);
        expanded.add(month.id);
        set({ expanded });
        get().openView(noteId);
      } finally {
        release();
      }
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      const tabs = [...get().tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      set({ tabs });
      persistNow();
    },

    setRoute: (route: Route) => set({ route }),

    openSearch: (query: string) => set({ route: "search", searchQuery: query, paletteOpen: false }),

    openPalette: () => set({ paletteOpen: true }),
    closePalette: () => set({ paletteOpen: false }),

    toggleExpand: (id: string) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      set({ expanded });
    },

    expand: (id: string) => {
      if (!get().expanded.has(id)) {
        set({ expanded: new Set(get().expanded).add(id) });
      }
    },

    setExpandedAll: (ids: Set<string>) => set({ expanded: ids }),

    setTagFilter: (tag) => set({ tagFilter: tag }),

    loadTagMeta: async () => {
      try {
        const raw = await viewApi.getSetting(TAG_META_KEY);
        set({ tagMeta: parseTagColors(raw) });
      } catch (e) {
        logger.warn("WorkspaceStore", "load tag meta failed", e);
      }
    },

    setTagColor: async (tag, color) => {
      // 颜色键取规范形：树/面板里同一标签无论什么写法都取到同一份配置
      const key = canonicalTagName(tag) || tag;
      const tagMeta = { ...get().tagMeta, [key]: color };
      set({ tagMeta });
      await persistTagMeta(tagMeta);
    },

    renameTag: async (from, to) => {
      const name = canonicalTagName(to);
      if (!name || name === canonicalTagName(from)) return;
      // 先算出每个受影响页面的新标签（层级改名：命中 from 子树的标签整体换前缀；同页去重）
      const affected = flattenTree(get().tree)
        .map((v) => ({ id: v.id, tags: parseViewTags(v.tags) }))
        .filter((a) => a.tags.some((x) => tagMatchesFilter(x, from)))
        .map((a) => ({ id: a.id, tags: [...new Set(a.tags.map((x) => renameTagPath(x, from, name)))] }));
      for (const a of affected) await viewApi.setTags(a.id, a.tags);
      set((state) => {
        let tree = state.tree;
        for (const a of affected) tree = patchTreeView(tree, a.id, { tags: JSON.stringify(a.tags) });
        return {
          tree,
          tagMeta: renameTagColor(state.tagMeta, from, name),
          tagFilter: state.tagFilter ? renameTagPath(state.tagFilter, from, name) : state.tagFilter,
        };
      });
      await persistTagMeta(get().tagMeta);
    },

    deleteTag: async (tag) => {
      // 层级删除：整个子树（含自身）的标签一并移除
      const affected = flattenTree(get().tree)
        .map((v) => ({ id: v.id, tags: parseViewTags(v.tags) }))
        .filter((a) => a.tags.some((x) => tagMatchesFilter(x, tag)))
        .map((a) => ({ id: a.id, tags: a.tags.filter((x) => !tagMatchesFilter(x, tag)) }));
      for (const a of affected) await viewApi.setTags(a.id, a.tags);
      set((state) => {
        let tree = state.tree;
        for (const a of affected) tree = patchTreeView(tree, a.id, { tags: JSON.stringify(a.tags) });
        return {
          tree,
          tagMeta: omitTagColor(state.tagMeta, tag),
          tagFilter: state.tagFilter && tagMatchesFilter(state.tagFilter, tag) ? null : state.tagFilter,
        };
      });
      await persistTagMeta(get().tagMeta);
    },

    setSidebarWidth: (w: number) => set({ sidebarWidth: w }),
  };
}) as unknown as UseWorkspaceStoreHook;

export const useWorkspaceStore = _useWorkspaceStore;

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

/** 树内查找节点（跨模块复用：first-heading-lock 按视图 id 取最新名称） */
export function findInTree(nodes: ViewNode[], id: string): ViewNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findInTree(n.children, id);
    if (found) return found;
  }
  return null;
}
