import { useState } from "react";
import { AlertTriangle, FolderOpen, RefreshCw, Upload } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

/** db_health 返回结构（Rust 侧字段名即 JSON 键名） */
export interface DbHealth {
  ok: boolean;
  error: string | null;
  db_path: string;
  db_size_bytes: number;
  data_dir: string;
  backup_dir: string;
  latest_backup: string | null;
  latest_backup_path: string | null;
  latest_backup_time: string | null;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 数据库不可用时的兜底页。本地优先定位下用户的数据必须能自己取回：
 * 这里摆出真实失败原因与库文件/数据目录/备份目录，并给出「打开数据目录」与
 * 「导入备份」两条互不依赖的恢复路径，避免只弹一句 error.db 让人无从下手。
 */
export function DbUnavailable({ health }: { health: DbHealth }) {
  const [busy, setBusy] = useState(false);

  const openDataDir = async () => {
    try {
      await invoke<void>("open_data_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /** 常见情形是库文件被别的程序占用：用户关掉后点这里即可恢复，无需重启应用 */
  const checkAgain = async () => {
    setBusy(true);
    try {
      const next = await invoke<DbHealth>("db_health");
      if (next.ok) {
        toast.success(t("db.errorRetryOk"));
        window.location.reload();
      } else {
        toast.error(t("error.db", { message: next.error ?? "" }));
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  /** path 为 null 时让用户自己挑一个 zip */
  const importBackup = async (path: string | null) => {
    let src = path;
    if (!src) {
      const picked = await open({
        multiple: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (typeof picked !== "string") return;
      src = picked;
    }
    const confirmed = window.confirm(
      `${t("settings.confirmImportTitle")}\n\n${t("settings.confirmImportDesc")}`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await invoke<void>("import_backup", { sourcePath: src });
      toast.success(t("settings.imported"));
      // 恢复会关闭并重开数据库连接，重新加载页面才能走一遍 init 把数据取回来
      window.location.reload();
    } catch (e) {
      logger.error("DbUnavailable.importBackup", "import backup failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50 px-6">
      <div className="w-full max-w-xl rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <header className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-neutral-900">{t("db.errorTitle")}</h1>
            <p className="mt-1 text-xs text-neutral-500">{t("db.errorDesc")}</p>
          </div>
        </header>

        {health.error && (
          <div className="mb-4 rounded-md bg-red-50 p-3">
            <div className="text-[11px] font-medium text-red-700">{t("db.errorReason")}</div>
            <div className="mt-1 font-mono text-[11px] break-all text-red-800">{health.error}</div>
          </div>
        )}

        <dl className="mb-4 space-y-2 text-[11px]">
          <PathRow
            label={t("db.errorDbFile")}
            value={`${health.db_path}（${formatSize(health.db_size_bytes)}）`}
          />
          <PathRow label={t("db.errorDataDir")} value={health.data_dir} />
          <PathRow label={t("db.errorBackupDir")} value={health.backup_dir} />
          <PathRow
            label={t("db.errorLatestBackup")}
            value={
              health.latest_backup
                ? `${health.latest_backup}${health.latest_backup_time ? ` · ${health.latest_backup_time}` : ""}`
                : t("db.errorNoBackup")
            }
          />
        </dl>

        <p className="mb-4 text-[11px] text-neutral-500">{t("db.errorHint")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void importBackup(health.latest_backup_path)}
            disabled={busy || !health.latest_backup_path}
          >
            {busy ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            {t("db.errorImportLatest")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void importBackup(null)} disabled={busy}>
            <Upload className="mr-1 h-3.5 w-3.5" />
            {t("db.errorImportOther")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void openDataDir()}>
            <FolderOpen className="mr-1 h-3.5 w-3.5" />
            {t("db.errorOpenDataDir")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void checkAgain()} disabled={busy}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t("db.errorRetry")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono break-all text-neutral-700">{value}</dd>
    </div>
  );
}