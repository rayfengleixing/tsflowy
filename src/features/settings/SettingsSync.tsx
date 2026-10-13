import { useEffect, useState } from "react";
import { FolderInput, FolderOpen, RefreshCw } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { detectDataDirRisk } from "@/lib/data-dir-risk";
import { flushAllForClose } from "@/lib/close-flush";
import { loadAutoSyncConfig, saveAutoSyncConfig, type AutoSyncConfig } from "@/lib/auto-sync";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import {
  SYNC_ACTION_KEY,
  Section,
  RiskNotice,
  formatBytes,
  type SyncInfo,
  type SyncRunResult,
  type ConflictFile,
} from "./settings-parts";

/** 文件夹同步：选目录/手动双向同步/自动化选项/冲突副本恢复 */
export function SettingsSync() {
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [busySync, setBusySync] = useState(false);
  // 冲突副本列表（进入同步区块时拉取；恢复/打开目录后刷新）
  const [conflictFiles, setConflictFiles] = useState<ConflictFile[]>([]);
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

  // 上次同步动作对应的文案 key；未知动作返回 undefined（不渲染）
  const syncLastActionKey = syncInfo?.last_action ? SYNC_ACTION_KEY[syncInfo.last_action] : undefined;
  const dataDirRisk = detectDataDirRisk(dataDir, syncInfo?.dir);

  const refreshSyncInfo = () => {
    invoke<SyncInfo>("get_sync_info")
      .then((info) => {
        setSyncInfo(info);
        if (info.dir) {
          invoke<ConflictFile[]>("list_sync_conflicts")
            .then(setConflictFiles)
            .catch((e: unknown) => logger.error("failed to list sync conflicts", e));
        } else {
          setConflictFiles([]);
        }
      })
      .catch((e: unknown) => logger.error("failed to get sync info", e));
  };

  /** 自动化选项：存 localStorage（前端定时器读它，无需后端往返） */
  const updateAutoSync = (patch: Partial<AutoSyncConfig>) => {
    const next = { ...autoSync, ...patch };
    setAutoSync(next);
    saveAutoSyncConfig(next);
  };

  /** 用冲突副本替换本机库：成功后必须重载（本机库已被换掉） */
  const restoreConflict = async (name: string) => {
    try {
      await flushAllForClose();
      await invoke("restore_sync_conflict", { name });
      window.location.reload();
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
   */
  const syncNow = async () => {
    setBusySync(true);
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
      const key = SYNC_ACTION_KEY[r.action] ?? "settings.syncActionNone";
      const extra = r.assets_copied > 0 ? ` · ${t("settings.syncAssets", { n: r.assets_copied })}` : "";
      if (r.action === "conflict") {
        toast.warning(t(key) + extra, {
          description:
            r.conflicts.length > 0 ? `${t("settings.syncConflictFiles")}: ${r.conflicts.join(", ")}` : undefined,
        });
      } else {
        toast.success(t(key) + extra);
      }
      if (r.pulled) {
        // 本机库刚被替换：立即重载，不能再等（原 1.5s 延迟窗口里编辑器会自动把旧内存态
        // 写回新库、覆盖刚拉取的内容）；重载后树/文档/设置页全部读新库
        window.location.reload();
        return;
      }
      // 未被替换：同步期间撞进维护窗口而失败的保存，这里重试一次
      await flushAllForClose();
    } catch (e) {
      logger.error("run sync failed", e);
      toast.error(`${t("settings.syncFailed")}：${String(e)}`);
    } finally {
      setBusySync(false);
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
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={syncNow} disabled={busySync}>
                <RefreshCw className={cn("mr-1 h-3.5 w-3.5", busySync && "animate-spin")} />
                {busySync ? "…" : t("settings.syncNow")}
              </Button>
              <Button size="sm" variant="outline" onClick={chooseSyncDir} disabled={busySync}>
                <FolderInput className="mr-1 h-3.5 w-3.5" />
                {t("settings.syncChange")}
              </Button>
              <Button size="sm" variant="outline" onClick={turnSyncOff} disabled={busySync}>
                {t("settings.syncOff")}
              </Button>
            </div>
            <div className="mt-3 text-[11px] text-neutral-500">
              {t("settings.syncLast")}：{syncInfo.last_time ?? t("settings.syncNever")}
              {syncLastActionKey && <span className="ml-2">{t(syncLastActionKey)}</span>}
            </div>
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
              <p className="max-w-lg text-[11px] text-neutral-400">{t("settings.syncAutoHint")}</p>
            </div>
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
                    <li key={f.name} className="flex items-center gap-2 px-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
                          {f.name}
                        </div>
                        <div className="text-[10px] text-neutral-400">
                          {f.modified} · {formatBytes(f.size)}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setRestoreTarget(f)}>
                        {t("settings.syncConflictRestore")}
                      </Button>
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
