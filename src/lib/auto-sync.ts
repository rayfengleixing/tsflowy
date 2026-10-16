import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { flushAllForClose } from "./close-flush";
import { requestSyncReload } from "./sync-events";
import { t } from "@/lib/i18n";
import { logger } from "./logger";

// 同步自动化（B7）：启动时拉取一次 + 本机写入静置后自动同步 + 周期性拉取。
// 全部在前端实现：业务模块统一从 @/lib/invoke 导入 invoke，包装层识别写命令后
// 调用 markLocalWrite 驱动防抖定时器；到点直接调用已有 run_sync 命令，
// 与设置页手动同步同一条链路（先冲刷挂起写入，pulled 后重载窗口）。
// 周期性同步独立走 setInterval：应用常开时远端更新也能按间隔拉到，
// 休眠/挂后台导致定时器停摆时，恢复回前台会自查周期并立刻补跑一拍。
// 本模块自身仍直接用 @tauri-apps/api/core（run_sync 不是写命令，且避免循环依赖）。

const CONFIG_KEY = "tsflowy:auto-sync";

export interface AutoSyncConfig {
  /** 启动时自动同步一次（拉取其他设备的更新） */
  pullOnStart: boolean;
  /** 本机写入静置后自动同步 */
  syncAfterWrite: boolean;
  /** 防抖延迟（秒）：最后一次写入后静置满这个时间才执行 */
  delaySecs: number;
  /** 周期性自动同步：无论本机有没有写入，按固定间隔跑一轮（拉取远端更新） */
  periodic: boolean;
  /** 周期同步的间隔（秒） */
  intervalSecs: number;
}

const DEFAULTS: AutoSyncConfig = {
  pullOnStart: false,
  syncAfterWrite: false,
  delaySecs: 60,
  periodic: false,
  intervalSecs: 300,
};

export function loadAutoSyncConfig(): AutoSyncConfig {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CONFIG_KEY);
  } catch {
    return DEFAULTS;
  }
  if (!raw) return DEFAULTS;
  try {
    const v = JSON.parse(raw) as Partial<AutoSyncConfig>;
    return {
      pullOnStart: v.pullOnStart === true,
      syncAfterWrite: v.syncAfterWrite === true,
      delaySecs:
        typeof v.delaySecs === "number" && Number.isFinite(v.delaySecs)
          ? Math.min(3600, Math.max(5, Math.round(v.delaySecs)))
          : DEFAULTS.delaySecs,
      periodic: v.periodic === true,
      intervalSecs:
        typeof v.intervalSecs === "number" && Number.isFinite(v.intervalSecs)
          ? Math.min(3600, Math.max(60, Math.round(v.intervalSecs)))
          : DEFAULTS.intervalSecs,
    };
  } catch (e) {
    logger.warn("autoSync", "config parse failed, fallback to default", e);
    return DEFAULTS;
  }
}

/** run_sync 返回结构中与自动同步相关的字段 */
interface SyncRunOutcome {
  action: string;
  pulled: boolean;
  conflicts?: string[];
  assets_copied?: number;
  assets_deleted?: number;
}

/**
 * 会改动本机库的命令（写命令）。auto-sync 只在其中任意一个被调用后重新计时。
 * 读命令、同步自身的命令（run_sync / restore_sync_conflict）不在其列。
 * 新增写命令时若忘记登记，最坏情况是这一次写入不触发自动同步，手动同步仍然有效。
 */
const WRITE_COMMANDS = new Set([
  "workspace_create",
  "workspace_rename",
  "workspace_set_icon",
  "workspace_remove",
  // view_touch_visited 不在列：仅"打开过页面"就刷新访问时间戳，若参与防抖，
  // 用户只是浏览也会不断触发自动同步/上传，还会推高两端冲突概率
  "view_create",
  "view_duplicate",
  "view_rename",
  "view_set_icon",
  "view_update_extra",
  "view_set_favorite",
  "view_set_tags",
  "view_soft_delete",
  "view_restore",
  "view_purge",
  "view_purge_trash",
  "view_purge_expired_trash",
  "view_move",
  "setting_set",
  "doc_save",
  "doc_snapshot_restore",
  "mention_rebuild",
  "pp_set",
  "pp_remove",
  "pp_rename",
  "field_create",
  "field_rename",
  "field_delete",
  "field_set_width",
  "field_set_hidden",
  "field_update_options",
  "field_reorder",
  "field_change_type",
  "row_create",
  "row_create_many",
  "row_set_document_id",
  "row_set_parent",
  "row_delete",
  "row_delete_many",
  "row_restore",
  "row_purge",
  "row_purge_trash",
  "row_purge_expired_trash",
  "row_reorder",
  "cell_set",
  "cell_set_many",
  "csv_import",
  "save_asset",
  "save_asset_bytes",
  "write_text_file",
  "write_binary_file",
  "mkdir_all",
  "import_backup",
  "restore_backup",
  "change_data_dir",
  "reset_data_dir_default",
  "rebuild_data_dir",
  "purge_orphan_assets",
  "set_auto_backup_config",
  "run_auto_backup_now",
  "set_sync_dir",
  "ai_save_config",
]);

let cfg: AutoSyncConfig = loadAutoSyncConfig();
let started = false;
let syncing = false;
/** 同步进行中又发生了新的写入：本轮结束后重新计时，而不是丢掉这次变更 */
let pendingDuringSync = false;
let timer: number | null = null;
let intervalTimer: number | null = null;
let lastSyncAt = 0;

function clearTimer() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function clearIntervalTimer() {
  if (intervalTimer !== null) {
    window.clearInterval(intervalTimer);
    intervalTimer = null;
    document.removeEventListener("visibilitychange", onForeground);
  }
}

async function doSync() {
  syncing = true;
  lastSyncAt = Date.now();
  clearTimer();
  try {
    // 与手动同步一致：先把编辑器/视图配置等挂起写入冲刷落库，再执行同步
    await flushAllForClose();
    const r = await invoke<SyncRunOutcome>("run_sync");
    logger.info("autoSync", `done: ${r.action}`);
    // 后台同步的结果必须让用户看得到：冲突与失败只写日志的话，
    // 用户会带着"以为已同步"的心智继续改数据
    if (r.pulled) {
      toast.info(t("sync.autoPulled"));
      // 本机库被远端替换：所有前端缓存都是旧数据，重载最彻底。
      // 正常情况下 sync:db-replaced 事件在换库那一刻就已经重载过了，这里是兜底
      // （监听没挂上时仍要重载，否则会继续把旧数据写进新库）
      requestSyncReload();
      return;
    }
    if (r.action === "conflict") {
      toast.warning(t("sync.autoConflict", { count: (r.conflicts ?? []).length }));
    }
  } catch (e) {
    logger.warn("autoSync", "run_sync failed", e);
    toast.error(t("sync.autoFailed", { message: e instanceof Error ? e.message : String(e) }));
  } finally {
    syncing = false;
    if (pendingDuringSync) {
      pendingDuringSync = false;
      armTimer();
    }
  }
}

function armTimer() {
  clearTimer();
  timer = window.setTimeout(() => void doSync(), cfg.delaySecs * 1000);
}

/** 休眠/最小化会冻结 setInterval，且恢复后不会补跑 overdue 的一拍：回前台时自查是否已超周期 */
function onForeground() {
  if (document.visibilityState !== "visible") return;
  if (!started || !cfg.periodic || syncing) return;
  if (Date.now() - lastSyncAt >= cfg.intervalSecs * 1000) void doSync();
}

/** 周期同步调度：与进行中的 sync 不重入——上一轮还没结束就跳过本拍，等下一拍 */
function armInterval() {
  clearIntervalTimer();
  if (!cfg.periodic) return;
  intervalTimer = window.setInterval(() => {
    if (syncing) return;
    void doSync();
  }, cfg.intervalSecs * 1000);
  document.addEventListener("visibilitychange", onForeground);
}

/**
 * main.tsx 包装 invoke 后对每个命令调用一次：写命令 → 重置防抖定时器。
 * 未启动 / 未开启 / 同步进行中时分别处理，同步进行中的写入记为 pending。
 */
export function markLocalWrite(cmd: string) {
  if (!started || !cfg.syncAfterWrite || !WRITE_COMMANDS.has(cmd)) return;
  if (syncing) {
    pendingDuringSync = true;
    return;
  }
  armTimer();
}

/** 设置页保存配置后刷新本模块的生效值 */
export function saveAutoSyncConfig(next: AutoSyncConfig): void {
  const prev = cfg;
  cfg = {
    pullOnStart: next.pullOnStart,
    syncAfterWrite: next.syncAfterWrite,
    delaySecs: Math.min(3600, Math.max(5, Math.round(next.delaySecs) || DEFAULTS.delaySecs)),
    periodic: next.periodic === true,
    intervalSecs: Math.min(3600, Math.max(60, Math.round(next.intervalSecs) || DEFAULTS.intervalSecs)),
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) {
    logger.warn("autoSync", "config persist failed", e);
  }
  // 关闭自动同步时撤掉已挂起的定时器
  if (!cfg.syncAfterWrite) clearTimer();
  // 周期开关/间隔变了才动调度定时器（其余字段修改不打断当前周期）
  if (cfg.periodic !== prev.periodic || cfg.intervalSecs !== prev.intervalSecs) {
    clearIntervalTimer();
    if (started && cfg.periodic) armInterval();
  }
}

/**
 * App 数据就绪后调用一次：
 * 开启"启动拉取"则先同步一次；开启"写入后同步"则由 markLocalWrite 驱动定时器；
 * 开启"周期同步"则挂起 setInterval（回前台自查周期，休眠超期时立刻补跑一拍）。
 */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  cfg = loadAutoSyncConfig();
  if (cfg.periodic) armInterval();
  if (cfg.pullOnStart) void doSync();
}
