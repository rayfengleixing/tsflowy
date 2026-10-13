import { useEffect, useState } from "react";
import { Download, FolderInput, FolderOutput, RefreshCw, Upload } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { importMarkdownFolder } from "@/lib/import-folder";
import { exportMarkdownFolder } from "@/lib/export-folder";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section, timestamp, type AutoBackupInfo } from "./settings-parts";

/** 备份与迁移：整库导出/导入 ZIP、Markdown 文件夹双向迁移、自动备份 */
export function SettingsBackup() {
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyImportFolder, setBusyImportFolder] = useState(false);
  const [busyExportFolder, setBusyExportFolder] = useState(false);
  const [autoBackup, setAutoBackup] = useState<AutoBackupInfo | null>(null);
  const [busyBackupNow, setBusyBackupNow] = useState(false);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  useEffect(() => {
    refreshAutoBackup();
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

  /** 立即备份一次（与自动备份同一链路，写入数据目录的 backups/） */
  const backupNow = async () => {
    setBusyBackupNow(true);
    try {
      await invoke<string>("run_auto_backup_now");
      toast.success(t("settings.autoBackupDone"));
      refreshAutoBackup();
    } catch (e) {
      logger.error("run auto backup failed", e);
      toast.error(`${t("settings.autoBackupFailed")}：${String(e)}`);
    } finally {
      setBusyBackupNow(false);
    }
  };

  return (
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
      </div>
    </Section>
  );
}
