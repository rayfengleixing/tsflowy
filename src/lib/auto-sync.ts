import { invoke } from "@tauri-apps/api/core";
import { flushAllForClose } from "./close-flush";
import { logger } from "./logger";

// 同步自动化（B7）：启动时拉取一次 + 本机写入静置后自动同步。
// 全部在前端实现：main.tsx 包装 __TAURI_INTERNALS__.invoke 这一个咽喉点识别写命令，
// 各写入口（编辑器/表格/视图配置…）无需任何改动；到点直接调用已有 run_sync 命令，
// 与设置页手动同步同一条链路（先冲刷挂起写入，pulled 后重载窗口）。

const CONFIG_KEY = "tsflowy:auto-sync";

export interface AutoSyncConfig {
  /** 启动时自动同步一次（拉取其他设备的更新） */
  pullOnStart: boolean;
  /** 本机写入静置后自动同步 */
  syncAfterWrite: boolean;
  /** 防抖延迟（秒）：最后一次写入后静置满这个时间才执行 */
  delaySecs: number;
}

const DEFAULTS: AutoSyncConfig = { pullOnStart: false, syncAfterWrite: false, delaySecs: 60 };

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
  "view_touch_visited",
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
  "row_delete",
  "row_delete_many",
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

function clearTimer() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

async function doSync() {
  syncing = true;
  clearTimer();
  try {
    // 与手动同步一致：先把编辑器/视图配置等挂起写入冲刷落库，再执行同步
    await flushAllForClose();
    const r = await invoke<SyncRunOutcome>("run_sync");
    logger.info("autoSync", `done: ${r.action}`);
    if (r.pulled) {
      // 本机库被远端替换：所有前端缓存都是旧数据，重载最彻底
      window.location.reload();
      return;
    }
  } catch (e) {
    logger.warn("autoSync", "run_sync failed", e);
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
  cfg = {
    pullOnStart: next.pullOnStart,
    syncAfterWrite: next.syncAfterWrite,
    delaySecs: Math.min(3600, Math.max(5, Math.round(next.delaySecs) || DEFAULTS.delaySecs)),
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) {
    logger.warn("autoSync", "config persist failed", e);
  }
  // 关闭自动同步时撤掉已挂起的定时器
  if (!cfg.syncAfterWrite) clearTimer();
}

/**
 * App 数据就绪后调用一次：
 * 开启"启动拉取"则先同步一次；开启"写入后同步"则由 markLocalWrite 驱动定时器。
 */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  cfg = loadAutoSyncConfig();
  if (cfg.pullOnStart) void doSync();
}
