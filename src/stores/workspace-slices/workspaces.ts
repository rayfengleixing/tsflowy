import { workspaceApi, viewApi } from "@/lib/db";
import { documentApi } from "@/lib/documents";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import { useSettingsStore } from "../settings";
import { buildWelcomeDoc, welcomeDocTitle } from "@/lib/welcome-doc";
import { patchTreeAndRestoreTabs } from "./tree";
import { flushPendingUiPersist } from "./persistence";
import type { WorkspaceGet, WorkspaceSliceCreator, WorkspaceState } from "./types";

let initPromise: Promise<void> | null = null;

/** 30 天回收站自动清空定时器：全局只建一次；每小时扫一次，跨空间清理 */
let autoPurgeTimer: ReturnType<typeof setInterval> | null = null;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

const purgeAllExpiredTrash = async (get: WorkspaceGet): Promise<void> => {
  const workspaces = get().workspaces;
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
  const ws = get().currentWorkspaceId;
  if (ws) await get().reload();
};

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

export const createWorkspacesSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  ready: false,
  workspaces: [],
  currentWorkspaceId: null,

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
        await patchTreeAndRestoreTabs(set, get);
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
          void purgeAllExpiredTrash(get);
          autoPurgeTimer = setInterval(() => {
            void purgeAllExpiredTrash(get);
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

  switchWorkspace: async (id: string) => {
    if (id === get().currentWorkspaceId) return;
    // 切换前立即把旧空间的 tabs 持久化（不等 300ms，避免丢失）
    await flushPendingUiPersist();

    set({ currentWorkspaceId: id, tabs: [], currentViewId: null, splitViewId: null });
    await viewApi.setSetting("last_workspace_id", id);
    await patchTreeAndRestoreTabs(set, get);
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
});
