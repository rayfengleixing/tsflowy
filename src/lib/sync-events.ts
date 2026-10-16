import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logger } from "./logger";
import { t, type MessageKey } from "@/lib/i18n";

// 同步过程的可观测性（Rust 侧见 src-tauri/src/commands/sync.rs）。
//
// 为什么需要事件而不是只看 run_sync 的返回值：一轮同步要算两次整库 sha256、复制可达数百 MB
// 的附件，命令返回前前端只能对着一个转圈的按钮等；更要命的是拉取路径——本机库一旦被替换，
// 后续补附件/写墓碑/落基线任何一步失败都会让命令报错，前端拿不到 pulled 标志就不重载，
// 渲染进程会继续把内存里的旧数据写进已经被换掉的库。
// 因此替换发生的那一刻就广播 sync:db-replaced，重载由这里统一负责。

/** 与 Rust 侧 SYNC_PROGRESS_EVENT 一致 */
export const SYNC_PROGRESS_EVENT = "sync:progress";
/** 与 Rust 侧 SYNC_DB_REPLACED_EVENT 一致 */
export const SYNC_DB_REPLACED_EVENT = "sync:db-replaced";

/** run_sync 结束时必发的一帧（失败路径也发），前端据此收掉进度条 */
const STAGE_DONE = "done";

/** Rust 侧 SyncProgress 的镜像 */
export interface SyncProgress {
  /** 阶段标识；见 Rust commands/sync.rs 的 stage 模块 */
  stage: string;
  /** 已完成量（哈希阶段为字节数，附件/墓碑阶段为文件数） */
  done: number;
  /** 总量；0 = 这一步无法预估工作量，前端画不定长进度条 */
  total: number;
}

/** 阶段 → 文案 key。文案留在前端，切换语言即时生效，无需 Rust 参与。
 * 值允许 undefined：按字符串查表，Rust 侧新增阶段时前端就是查不到 */
export const SYNC_STAGE_KEY: Record<string, MessageKey | undefined> = {
  snapshot: "settings.syncStageSnapshot",
  hash_local: "settings.syncStageHashLocal",
  hash_remote: "settings.syncStageHashRemote",
  replace_db: "settings.syncStageReplace",
  assets: "settings.syncStageAssets",
  tombstones: "settings.syncStageTombstones",
};

export function syncStageLabel(p: SyncProgress): string {
  return t(SYNC_STAGE_KEY[p.stage] ?? "settings.syncStageWorking");
}

/** 进度百分比；无法预估时返回 null */
export function syncProgressPercent(p: SyncProgress): number | null {
  if (p.total <= 0) return null;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

type ProgressHandler = (p: SyncProgress | null) => void;

const handlers = new Set<ProgressHandler>();
let registration: Promise<UnlistenFn[]> | null = null;
let reloadRequested = false;

/**
 * 本机库已被替换：整窗重载。
 * 事件与命令返回值都会走到这里，用一次性闸门避免重复重载（重载一旦开始就不再回来，
 * 闸门只需存在一次即可，不必复位）。
 */
export function requestSyncReload(): void {
  if (reloadRequested) return;
  reloadRequested = true;
  window.location.reload();
}

/** 订阅同步进度；回调收到 null 表示这一轮同步结束（成功或失败）。返回退订函数 */
export function onSyncProgress(handler: ProgressHandler): () => void {
  void startSyncEvents();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 挂上 Rust 事件监听（幂等）。App 启动与设置页订阅时各调一次即可 */
export function startSyncEvents(): Promise<UnlistenFn[]> {
  if (registration) return registration;
  registration = Promise.all([
    listen<SyncProgress>(SYNC_PROGRESS_EVENT, (e) => {
      const p = e.payload;
      const finished = p.stage === STAGE_DONE;
      // 先广播再复位：订阅者各自决定要不要留着最后一帧
      for (const h of handlers) h(finished ? null : p);
    }),
    listen(SYNC_DB_REPLACED_EVENT, () => {
      requestSyncReload();
    }),
  ]).catch((e: unknown) => {
    // 监听没挂上时退回"看 run_sync 返回值决定是否重载"的旧路径（调用方仍会调 requestSyncReload）
    registration = null;
    logger.warn("syncEvents", "listen failed", e);
    return [] as UnlistenFn[];
  });
  return registration;
}
