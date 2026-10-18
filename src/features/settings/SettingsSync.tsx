import { useEffect, useState } from "react";
import { FolderInput, FolderOpen, RefreshCw } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { detectDataDirRisk, isCloudManagedPath } from "@/lib/data-dir-risk";
import { flushAllForClose } from "@/lib/close-flush";
import {
  onSyncProgress,
  requestSyncReload,
  syncProgressPercent,
  syncStageLabel,
  type SyncProgress,
} from "@/lib/sync-events";
import { loadAutoSyncConfig, saveAutoSyncConfig, type AutoSyncConfig } from "@/lib/auto-sync";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import {
  SYNC_ACTION_KEY,
  SYNC_SIDE_KEY,
  ConflictPreviewPanel,
  Section,
  RiskNotice,
  SyncSecurityNote,
  formatBytes,
  formatDuration,
  type SyncInfo,
  type SyncRunResult,
  type SyncHistoryEntry,
  type ConflictFile,
  type ConflictPreview,
} from "./settings-parts";

/** 一次只展开一份冲突副本的预览（拉取的是两份库的只读统计，没必要同时开多个） */
interface PreviewState {
  name: string;
  loading: boolean;
  error: string | null;
  data: ConflictPreview | null;
}

/** 文件夹同步：选目录/手动双向同步/自动化选项/冲突副本恢复 */
export function SettingsSync() {
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [busySync, setBusySync] = useState(false);
  // 同步进度（Rust 侧按阶段广播；后台自动同步的进度同样会流到这里）
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  // 最近一次同步的冲突详情（只在 action=conflict 时有值，用于解释裁决结果）
  const [lastConflict, setLastConflict] = useState<SyncRunResult | null>(null);
  // 冲突副本列表（进入同步区块时拉取；恢复/打开目录后刷新）
  const [conflictFiles, setConflictFiles] = useState<ConflictFile[]>([]);
  // 最近若干轮同步的留档：手动同步和后台自动同步都写这里，回答「刚才那一次做了什么」
  const [history, setHistory] = useState<SyncHistoryEntry[]>([]);
  // 当前展开预览的冲突副本（同一时刻只看一份）
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // 待确认恢复的冲突副本（恢复会替换本机库，先确认）
  const [restoreTarget, setRestoreTarget] = useState<ConflictFile | null>(null);
  // 同步自动化选项（localStorage，见 lib/auto-sync.ts）
  const [autoSync, setAutoSync] = useState<AutoSyncConfig>(() => loadAutoSyncConfig());
  // 仅为风险检测拉取数据目录；数据目录改动需重启才生效，进入本页时取一次即可
  const [dataDir, setDataDir] = useState<string>("");

  useEffect(() => {
    refreshSyncInfo();
    invoke<string>("data_dir_path")
      .then(setDataDir)
      .catch((e: unknown) => logger.error("failed to get data dir", e));
  }, []);

  // 进度事件订阅：手动同步与后台自动同步共用一根进度条
  useEffect(() => onSyncProgress(setProgress), []);

  // 上次同步动作对应的文案 key；未知动作返回 undefined（不渲染）
  const syncLastActionKey = syncInfo?.last_action ? SYNC_ACTION_KEY[syncInfo.last_action] : undefined;
  const dataDirRisk = detectDataDirRisk(dataDir, syncInfo?.dir);
  // 百分比为 null：这一步（快照/换库）报不出量，画成不定长的脉冲条
  const syncPercent = progress ? syncProgressPercent(progress) : null;

  const refreshSyncInfo = () => {
    invoke<SyncInfo>("get_sync_info")
      .then((info) => {
        setSyncInfo(info);
        if (info.dir) {
          invoke<ConflictFile[]>("list_sync_conflicts")
            .then(setConflictFiles)
            .catch((e: unknown) => logger.error("failed to list sync conflicts", e));
          invoke<SyncHistoryEntry[]>("get_sync_history")
            .then(setHistory)
            .catch((e: unknown) => logger.error("failed to get sync history", e));
        } else {
          setConflictFiles([]);
          setHistory([]);
        }
      })
      .catch((e: unknown) => logger.error("failed to get sync info", e));
  };

  /** 清空历史只删 config.json 里的留档，同步文件夹与本机库都不动 */
  const clearHistory = async () => {
    try {
      await invoke("clear_sync_history");
      setHistory([]);
      toast.success(t("settings.syncHistoryCleared"));
    } catch (e) {
      logger.error("clear sync history failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /** 展开/收起一份冲突副本的预览：Rust 侧只读统计，不碰本机库 */
  const togglePreview = (name: string) => {
    if (preview?.name === name) {
      setPreview(null);
      return;
    }
    setPreview({ name, loading: true, error: null, data: null });
    invoke<ConflictPreview>("preview_sync_conflict", { name })
      .then((data) => setPreview((p) => (p?.name === name ? { name, loading: false, error: null, data } : p)))
      .catch((e: unknown) =>
        setPreview((p) => (p?.name === name ? { name, loading: false, error: String(e), data: null } : p)),
      );
  };

  /** 自动化选项：存 localStorage（前端定时器读它，无需后端往返） */
  const updateAutoSync = (patch: Partial<AutoSyncConfig>) => {
    const next = { ...autoSync, ...patch };
    setAutoSync(next);
    saveAutoSyncConfig(next);
  };

  /** 用冲突副本替换本机库：Rust 侧换库即广播替换事件，这里兜底保证一定重载 */
  const restoreConflict = async (name: string) => {
    try {
      await flushAllForClose();
      await invoke("restore_sync_conflict", { name });
      requestSyncReload();
    } catch (e) {
      logger.error("restore conflict failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const openConflictsDir = async () => {
    try {
      await invoke("open_conflicts_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /** 选/换同步文件夹（传空串 = 关闭同步） */
  const chooseSyncDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      setSyncInfo(await invoke<SyncInfo>("set_sync_dir", { dir: picked }));
    } catch (e) {
      logger.error("set sync dir failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const turnSyncOff = async () => {
    try {
      setSyncInfo(await invoke<SyncInfo>("set_sync_dir", { dir: "" }));
    } catch (e) {
      logger.error("disable sync failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const openSyncDir = async () => {
    try {
      await invoke<void>("open_sync_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /**
   * 手动双向同步。拉取（本机库被远端替换）后前端的树/表格/文档全是旧数据，
   * 必须重新加载——直接重载窗口最彻底，避免残留缓存的旧文档回写覆盖远端数据。
   * 重载由 sync:db-replaced 事件驱动（换库那一刻就发），这里的 pulled 分支只是兜底：
   * 监听器注册是异步的，冷启动首轮同步可能赶在它前面。
   */
  const syncNow = async () => {
    setBusySync(true);
    setProgress(null);
    setLastConflict(null);
    try {
      // 同步会短暂关库（拉取时还要替换本机库）：先把编辑器自动保存、视图配置等挂起写入
      // 全部冲刷落盘，避免它们撞进维护窗口失败，或落在随即被替换的旧库上
      await flushAllForClose();
      const r = await invoke<SyncRunResult>("run_sync");
      setSyncInfo(r.info);
      // 本次可能新产生/清理了冲突副本，重新拉取列表
      invoke<ConflictFile[]>("list_sync_conflicts")
        .then(setConflictFiles)
        .catch((e: unknown) => logger.error("failed to list sync conflicts", e));
      invoke<SyncHistoryEntry[]>("get_sync_history")
        .then(setHistory)
        .catch((e: unknown) => logger.error("failed to get sync history", e));
      const key = SYNC_ACTION_KEY[r.action] ?? "settings.syncActionNone";
      const extra = r.assets_copied > 0 ? ` · ${t("settings.syncAssets", { n: r.assets_copied })}` : "";
      if (r.action === "conflict") {
        setLastConflict(r);
        const side = r.conflict_winner === "local" ? t("settings.syncWinnerLocal") : t("settings.syncWinnerRemote");
        toast.warning(t(key) + extra, {
          description: `${t("settings.syncConflictWinner", { side })} · ${t("settings.syncConflictSaved", {
            n: String(r.conflicts.length),
          })}`,
        });
      } else {
        toast.success(t(key) + extra);
      }
      if (r.pulled) {
        // 本机库刚被替换：立即重载，不能再等（原 1.5s 延迟窗口里编辑器会自动把旧内存态
        // 写回新库、覆盖刚拉取的内容）；重载后树/文档/设置页全部读新库
        requestSyncReload();
        return;
      }
      // 未被替换：同步期间撞进维护窗口而失败的保存，这里重试一次
      await flushAllForClose();
    } catch (e) {
      logger.error("run sync failed", e);
      toast.error(`${t("settings.syncFailed")}：${String(e)}`);
    } finally {
      setBusySync(false);
      setProgress(null);
    }
  };

  return (
    <>
      <Section title={t("settings.sync")}>
        <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.syncDesc")}</p>
        {syncInfo?.dir ? (
          <>
            <div className="mb-1 text-[11px] text-neutral-500">{t("settings.syncDirLabel")}</div>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={syncInfo.sync_path ?? syncInfo.dir}
                className="flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 font-mono text-[11px] text-neutral-700 outline-none"
              />
              <Button size="sm" variant="outline" onClick={openSyncDir}>
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                {t("settings.syncOpen")}
              </Button>
            </div>
            {dataDirRisk === "sync-overlap" && <RiskNotice risk={dataDirRisk} />}
            <SyncSecurityNote cloudDir={isCloudManagedPath(syncInfo.dir)} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={syncNow} disabled={busySync}>
                <RefreshCw className={cn("mr-1 h-3.5 w-3.5", busySync && "animate-spin")} />
                {busySync ? t("settings.syncRunning") : t("settings.syncNow")}
              </Button>
              <Button size="sm" variant="outline" onClick={chooseSyncDir} disabled={busySync}>
                <FolderInput className="mr-1 h-3.5 w-3.5" />
                {t("settings.syncChange")}
              </Button>
              <Button size="sm" variant="outline" onClick={turnSyncOff} disabled={busySync}>
                {t("settings.syncOff")}
              </Button>
            </div>
            {/* 进度：一轮同步要算两次整库 sha256 并复制附件，没有阶段与百分比就只剩干等 */}
            {busySync && (
              <div className="mt-3 max-w-lg">
                <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
                  <span>{progress ? syncStageLabel(progress) : t("settings.syncStageWorking")}</span>
                  <span>{syncPercent !== null ? `${syncPercent}%` : ""}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                  <div
                    className={cn(
                      "h-full rounded-full bg-brand-500 transition-[width] duration-150",
                      syncPercent === null && "w-full animate-pulse opacity-40",
                    )}
                    style={syncPercent !== null ? { width: `${syncPercent}%` } : undefined}
                  />
                </div>
              </div>
            )}
            <div className="mt-3 text-[11px] text-neutral-500">
              {t("settings.syncLast")}：{syncInfo.last_time ?? t("settings.syncNever")}
              {syncLastActionKey && <span className="ml-2">{t(syncLastActionKey)}</span>}
            </div>
            {/* 冲突详情：把裁决依据摊开，用户才知道被舍弃的是哪一份、去哪取回 */}
            {lastConflict && (
              <div className="mt-3 max-w-lg rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <div className="mb-1 font-medium">{t("settings.syncActionConflict")}</div>
                <div>
                  {t("settings.syncConflictWinner", {
                    side:
                      lastConflict.conflict_winner === "local"
                        ? t("settings.syncWinnerLocal")
                        : t("settings.syncWinnerRemote"),
                  })}
                </div>
                <div className="mt-0.5">
                  {t("settings.syncLocalActivity")}：{lastConflict.local_activity ?? t("settings.syncActivityUnknown")}
                </div>
                <div>
                  {t("settings.syncRemoteActivity")}：
                  {lastConflict.remote_activity ?? t("settings.syncActivityUnknown")}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                <input
                  type="checkbox"
                  checked={autoSync.pullOnStart}
                  onChange={(e) => updateAutoSync({ pullOnStart: e.target.checked })}
                />
                {t("settings.syncAutoPull")}
              </label>
              <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                <input
                  type="checkbox"
                  checked={autoSync.syncAfterWrite}
                  onChange={(e) => updateAutoSync({ syncAfterWrite: e.target.checked })}
                />
                {t("settings.syncAutoWrite")}
                {autoSync.syncAfterWrite && (
                  <span className="ml-1 flex items-center gap-1 text-[11px] text-neutral-500">
                    {t("settings.syncAutoDelay")}
                    <input
                      type="number"
                      min={5}
                      max={3600}
                      defaultValue={autoSync.delaySecs}
                      key={autoSync.delaySecs}
                      onBlur={(e) => updateAutoSync({ delaySecs: Number(e.target.value) })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className="h-6 w-16 rounded-md border border-neutral-300 bg-white px-1.5 text-[11px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                    {t("settings.syncAutoDelayUnit")}
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                <input
                  type="checkbox"
                  checked={autoSync.periodic}
                  onChange={(e) => updateAutoSync({ periodic: e.target.checked })}
                />
                {t("settings.syncAutoPeriodic")}
                {autoSync.periodic && (
                  <span className="ml-1 flex items-center gap-1 text-[11px] text-neutral-500">
                    {t("settings.syncAutoInterval")}
                    <input
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      defaultValue={autoSync.intervalSecs / 60}
                      key={autoSync.intervalSecs}
                      onBlur={(e) => updateAutoSync({ intervalSecs: Number(e.target.value) * 60 })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      className="h-6 w-16 rounded-md border border-neutral-300 bg-white px-1.5 text-[11px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                    {t("settings.syncAutoIntervalUnit")}
                  </span>
                )}
              </label>
              <p className="max-w-lg text-[11px] text-neutral-400">{t("settings.syncAutoHint")}</p>
            </div>
            {/* 同步历史：后台自动同步没有 toast，能看到的只有这里 */}
            {history.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                    {t("settings.syncHistoryTitle")}
                  </span>
                  <button
                    className="text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
                    onClick={clearHistory}
                  >
                    {t("settings.syncHistoryClear")}
                  </button>
                </div>
                <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
                  {history.map((h, i) => {
                    const labelKey = SYNC_ACTION_KEY[h.action] ?? "settings.syncActionNone";
                    return (
                      <li
                        key={`${h.time}-${i}`}
                        className="text-[11px] leading-snug text-neutral-600 dark:text-neutral-300"
                      >
                        <span className="font-mono text-neutral-400">{h.time}</span> · {t(labelKey)} ·{" "}
                        {formatDuration(h.duration_ms)}
                        {h.assets_copied > 0 && <> · {t("settings.syncAssets", { n: h.assets_copied })}</>}
                        {h.assets_deleted > 0 && <> · {t("settings.syncHistoryDeleted", { n: h.assets_deleted })}</>}
                        {h.conflicts.length > 0 && (
                          <> · {t("settings.syncHistoryConflicts", { n: h.conflicts.length })}</>
                        )}
                        {h.error && (
                          <div className="mt-0.5 break-words text-red-600 dark:text-red-400">
                            {t("settings.syncHistoryError", { message: h.error })}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1 text-[10px] text-neutral-400">{t("settings.syncHistoryHint")}</p>
              </div>
            )}
            {conflictFiles.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                    {t("settings.syncConflictsTitle")}（{conflictFiles.length}）
                  </span>
                  <button className="text-[11px] text-brand-600 hover:underline" onClick={openConflictsDir}>
                    {t("settings.syncConflictsOpen")}
                  </button>
                </div>
                <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
                  {conflictFiles.map((f) => (
                    <li key={f.name} className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
                            {f.name}
                          </div>
                          <div className="text-[10px] text-neutral-400">
                            {t(SYNC_SIDE_KEY[f.side])} · {f.modified} · {formatBytes(f.size)}
                            {f.activity && (
                              <>
                                {" "}
                                · {t("settings.syncConflictActivity")} {f.activity}
                              </>
                            )}
                          </div>
                        </div>
                        <button
                          className="shrink-0 text-[11px] text-brand-600 hover:underline"
                          onClick={() => togglePreview(f.name)}
                        >
                          {t(
                            preview?.name === f.name
                              ? "settings.syncConflictPreviewHide"
                              : "settings.syncConflictPreview",
                          )}
                        </button>
                        <Button size="sm" variant="outline" onClick={() => setRestoreTarget(f)}>
                          {t("settings.syncConflictRestore")}
                        </Button>
                      </div>
                      {preview?.name === f.name && (
                        <ConflictPreviewPanel loading={preview.loading} error={preview.error} data={preview.data} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] text-neutral-500">{t("settings.syncOffHint")}</span>
            <Button size="sm" variant="outline" onClick={chooseSyncDir}>
              <FolderInput className="mr-1 h-3.5 w-3.5" />
              {t("settings.syncChoose")}
            </Button>
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        danger
        title={t("settings.syncConflictRestore")}
        description={t("settings.syncConflictRestoreConfirm", { name: restoreTarget?.name ?? "" })}
        confirmLabel={t("settings.syncConflictRestore")}
        onConfirm={() => {
          const name = restoreTarget?.name;
          setRestoreTarget(null);
          if (name) void restoreConflict(name);
        }}
      />
    </>
  );
}
