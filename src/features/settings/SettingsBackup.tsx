import { useEffect, useState } from "react";
import { Download, FolderInput, FolderOutput, RefreshCw, Upload } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { importMarkdownFolder } from "@/lib/import-folder";
import { exportMarkdownFolder } from "@/lib/export-folder";
import { flushAllForClose } from "@/lib/close-flush";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { sortBackupArchives, type BackupArchive } from "./backup-archive";
import {
  fetchRetentionPolicy,
  normalizeRetentionPolicy,
  RETENTION_LIMITS,
  type RetentionPolicy,
} from "@/lib/retention";
import { Section, formatBytes, timestamp, type AutoBackupInfo } from "./settings-parts";
import type { MessageKey } from "@/lib/i18n";

/** 「数据保留策略」的四个输入项：label 走 i18n，边界与 clamp 口径见 lib/retention */
const RETENTION_FIELDS: { key: keyof RetentionPolicy; labelKey: MessageKey }[] = [
  { key: "snapshot_interval_minutes", labelKey: "settings.snapshotInterval" },
  { key: "snapshot_keep", labelKey: "settings.snapshotKeep" },
  { key: "snapshot_pre_restore_keep", labelKey: "settings.snapshotPreRestore" },
  { key: "trash_retention_days", labelKey: "settings.trashRetention" },
];

/** 备份与迁移：整库导出/导入 ZIP、Markdown 文件夹双向迁移、自动备份、数据保留策略 */
export function SettingsBackup() {
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyImportFolder, setBusyImportFolder] = useState(false);
  const [busyExportFolder, setBusyExportFolder] = useState(false);
  const [autoBackup, setAutoBackup] = useState<AutoBackupInfo | null>(null);
  const [busyBackupNow, setBusyBackupNow] = useState(false);
  // 数据保留策略（文档快照 + 回收站自动清空），存 Rust 侧 config.json
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  // 备份归档列表（backups/ 目录，以磁盘为准）：进页拉一次，「立即备份」/恢复失败后刷新
  const [backups, setBackups] = useState<BackupArchive[]>([]);
  // 待确认恢复的备份（恢复会整体替换本机库，先二次确认）
  const [restoreTarget, setRestoreTarget] = useState<BackupArchive | null>(null);
  const [busyRestore, setBusyRestore] = useState(false);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  useEffect(() => {
    refreshAutoBackup();
    refreshBackups();
    refreshRetention();
  }, []);

  const exportBackup = async () => {
    setBusyExport(true);
    try {
      const target = await save({
        defaultPath: `tsflowy-backup-${timestamp()}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!target) return;
      await invoke<void>("export_backup", { targetPath: target });
      toast.success(t("settings.exported"));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyExport(false);
    }
  };

  const importBackup = async () => {
    const ok = window.confirm(`${t("settings.confirmImportTitle")}\n\n${t("settings.confirmImportDesc")}`);
    if (!ok) return;
    setBusyImport(true);
    try {
      const src = await open({
        multiple: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (typeof src !== "string") return;
      await invoke<void>("import_backup", { sourcePath: src });
      toast.success(t("settings.imported"));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyImport(false);
    }
  };

  // 导入 Markdown 文件夹：遍历 .md → 按目录层级建页 → reload 刷树
  const importFolder = async () => {
    if (!currentWorkspaceId) return;
    setBusyImportFolder(true);
    try {
      const result = await importMarkdownFolder(currentWorkspaceId);
      if (result.total === 0) {
        toast.info(t("settings.importFolderEmpty"));
      } else {
        if (result.created > 0) toast.success(t("settings.importedFolder", { n: result.created }));
        if (result.failed > 0) toast.warning(t("settings.importFolderFailed", { n: result.failed }));
        await useWorkspaceStore.getState().reload();
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyImportFolder(false);
    }
  };

  // 整库导出 Markdown：按页面树递归导出 .md（有子页面的页面 → 同名文件夹）
  const exportFolder = async () => {
    setBusyExportFolder(true);
    try {
      const result = await exportMarkdownFolder();
      if (!result) return; // 用户取消
      if (result.total === 0) {
        toast.info(t("settings.exportFolderEmpty"));
      } else {
        if (result.exported > 0) toast.success(t("settings.exportedFolder", { n: result.exported }));
        if (result.failed > 0) toast.warning(t("settings.exportFolderFailed", { n: result.failed }));
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyExportFolder(false);
    }
  };

  const refreshAutoBackup = () => {
    invoke<AutoBackupInfo>("get_auto_backup_config")
      .then(setAutoBackup)
      .catch((e: unknown) => logger.error("failed to get auto backup config", e));
  };

  const refreshBackups = () => {
    invoke<BackupArchive[]>("list_backups")
      .then((list) => setBackups(sortBackupArchives(list)))
      .catch((e: unknown) => logger.error("failed to list backups", e));
  };

  /** 数据保留策略：读失败时 lib 内部回落默认值，这里只需落进 state */
  const refreshRetention = () => {
    void fetchRetentionPolicy().then(setRetention);
  };

  /** 三项一起写回（Rust 侧命令接收完整配置），成功后用返回值刷新展示 */
  const persistAutoBackup = async (next: AutoBackupInfo) => {
    setAutoBackup(next); // 乐观更新，输入框即时响应
    try {
      const saved = await invoke<AutoBackupInfo>("set_auto_backup_config", {
        enabled: next.enabled,
        intervalHours: next.interval_hours,
        keep: next.keep,
      });
      setAutoBackup(saved);
    } catch (e) {
      logger.error("save auto backup config failed", e);
      toast.error(t("error.db", { message: String(e) }));
      refreshAutoBackup();
    }
  };

  /**
   * 写回数据保留策略（四项一起传，越界值前端先夹好，Rust 侧还会再夹一次）。
   * 输入框失焦即落盘：快照与自动清空的参数都是"下次生效"型，没有需要攒批的中间态。
   */
  const persistRetention = async (next: RetentionPolicy) => {
    const valid = normalizeRetentionPolicy(next);
    setRetention(valid); // 乐观更新，输入框立即显示回落后的值
    try {
      const saved = await invoke<RetentionPolicy>("set_retention_policy", {
        snapshotIntervalMinutes: valid.snapshot_interval_minutes,
        snapshotKeep: valid.snapshot_keep,
        snapshotPreRestoreKeep: valid.snapshot_pre_restore_keep,
        trashRetentionDays: valid.trash_retention_days,
      });
      setRetention(normalizeRetentionPolicy(saved));
    } catch (e) {
      logger.error("save retention policy failed", e);
      toast.error(t("error.db", { message: String(e) }));
      refreshRetention();
    }
  };

  /** 立即备份一次（与自动备份同一链路，写入数据目录的 backups/） */
  const backupNow = async () => {
    setBusyBackupNow(true);
    try {
      await invoke<string>("run_auto_backup_now");
      toast.success(t("settings.autoBackupDone"));
      refreshAutoBackup();
      refreshBackups();
    } catch (e) {
      logger.error("run auto backup failed", e);
      toast.error(`${t("settings.autoBackupFailed")}：${String(e)}`);
    } finally {
      setBusyBackupNow(false);
    }
  };

  const openBackupsDir = async () => {
    try {
      await invoke("open_backups_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /**
   * 用列表里的归档恢复本机数据：与「导入备份」同一条后端链路（关库 → 替换 → 重开），
   * 本机库已被替换、前端缓存全是旧数据，成功后立即重载窗口
   * （沿用 设置 → 双向同步 冲突副本恢复的做法，重载比"重启应用"提示更彻底）。
   */
  const restoreBackup = async (name: string) => {
    setBusyRestore(true);
    try {
      // 恢复会短暂关库：先冲刷挂起写入，避免它们撞进维护窗口失败（或落在即将被替换的旧库上）
      await flushAllForClose();
      await invoke("restore_backup", { name });
      window.location.reload();
    } catch (e) {
      logger.error("restore backup failed", e);
      toast.error(t("error.db", { message: String(e) }));
      setBusyRestore(false);
      refreshBackups();
    }
  };

  return (
    <>
      <Section title={t("settings.backup")}>
        <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.backupDesc")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={exportBackup} disabled={busyExport}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {busyExport ? "…" : t("settings.exportBackup")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={importBackup}
            disabled={busyImport}
            className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-600"
          >
            {busyImport ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.importBackup")}
          </Button>
          <Button size="sm" variant="outline" onClick={importFolder} disabled={busyImportFolder}>
            {busyImportFolder ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderInput className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.importFolder")}
          </Button>
          <Button size="sm" variant="outline" onClick={exportFolder} disabled={busyExportFolder}>
            {busyExportFolder ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOutput className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.exportFolder")}
          </Button>
        </div>

        <div className="mt-4 border-t border-neutral-200 pt-4">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
            <input
              type="checkbox"
              checked={autoBackup?.enabled ?? false}
              disabled={!autoBackup}
              onChange={(e) => autoBackup && persistAutoBackup({ ...autoBackup, enabled: e.target.checked })}
            />
            {t("settings.autoBackupEnable")}
          </label>
          <p className="mb-3 mt-1.5 max-w-lg text-[11px] text-neutral-500">{t("settings.autoBackupDesc")}</p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              {t("settings.autoBackupInterval")}
              <input
                type="number"
                min={1}
                max={720}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                value={autoBackup?.interval_hours ?? 24}
                disabled={!autoBackup}
                onChange={(e) => autoBackup && setAutoBackup({ ...autoBackup, interval_hours: Number(e.target.value) })}
                onBlur={() => autoBackup && persistAutoBackup(autoBackup)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              {t("settings.autoBackupKeep")}
              <input
                type="number"
                min={1}
                max={100}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                value={autoBackup?.keep ?? 7}
                disabled={!autoBackup}
                onChange={(e) => autoBackup && setAutoBackup({ ...autoBackup, keep: Number(e.target.value) })}
                onBlur={() => autoBackup && persistAutoBackup(autoBackup)}
              />
            </label>
            <Button size="sm" variant="outline" onClick={backupNow} disabled={busyBackupNow || !autoBackup}>
              {busyBackupNow ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.autoBackupNow")}
            </Button>
          </div>
          {autoBackup && (
            <div className="mt-3 text-[11px] text-neutral-500">
              {t("settings.autoBackupLast")}：{autoBackup.last_backup ?? t("settings.autoBackupNever")}
              <span className="ml-2 break-all font-mono">{autoBackup.dir}</span>
            </div>
          )}

          {/* 备份归档列表：backups/ 目录磁盘实况（auto-*.zip 与手动导出的 tsflowy-backup-*.zip） */}
          <div className="mt-4 border-t border-neutral-200 pt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                {t("settings.backupListTitle")}（{backups.length}）
              </span>
              <button type="button" className="text-[11px] text-brand-600 hover:underline" onClick={openBackupsDir}>
                {t("settings.backupOpenDir")}
              </button>
            </div>
            {backups.length === 0 ? (
              <p className="text-[11px] text-neutral-400">{t("settings.backupListEmpty")}</p>
            ) : (
              <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
                {backups.map((b) => (
                  <li key={b.name} className="flex items-center gap-2 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
                        {b.name}
                      </div>
                      <div className="text-[10px] text-neutral-400">
                        {b.modified} · {formatBytes(b.size)}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={busyRestore} onClick={() => setRestoreTarget(b)}>
                      {busyRestore ? "…" : t("settings.backupRestore")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section title={t("settings.retention")}>
        <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.retentionDesc")}</p>
        <div className="flex flex-wrap items-end gap-4">
          {RETENTION_FIELDS.map((field) => {
            const limit = RETENTION_LIMITS[field.key];
            return (
              <label key={field.key} className="flex flex-col gap-1 text-[11px] text-neutral-600">
                {t(field.labelKey)}
                <input
                  type="number"
                  min={limit.min}
                  max={limit.max}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                  value={retention?.[field.key] ?? ""}
                  disabled={!retention}
                  onChange={(e) => retention && setRetention({ ...retention, [field.key]: Number(e.target.value) })}
                  onBlur={() => retention && void persistRetention(retention)}
                />
              </label>
            );
          })}
        </div>
      </Section>

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        danger
        title={t("settings.confirmImportTitle")}
        description={t("settings.backupRestoreConfirm", { name: restoreTarget?.name ?? "" })}
        confirmLabel={t("settings.backupRestore")}
        onConfirm={() => {
          const name = restoreTarget?.name;
          setRestoreTarget(null);
          if (name) void restoreBackup(name);
        }}
      />
    </>
  );
}
