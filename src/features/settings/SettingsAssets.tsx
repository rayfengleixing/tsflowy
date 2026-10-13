import { useState } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { scanOrphanAssets, purgeOrphanAssets, type OrphanScan } from "@/lib/assets";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section, formatBytes } from "./settings-parts";

/** 未引用附件：扫描 assets/ 孤儿文件，确认后移入备份目录（非删除） */
export function SettingsAssets() {
  // scan 为 null 表示本次进入设置页后还没扫描过
  const [orphanScan, setOrphanScan] = useState<OrphanScan | null>(null);
  const [busyAssets, setBusyAssets] = useState(false);
  const [purgeAssetsOpen, setPurgeAssetsOpen] = useState(false);

  /** 扫描 assets/ 下不再被引用的资源（只读，不动磁盘） */
  const scanAssets = async () => {
    setBusyAssets(true);
    try {
      const res = await scanOrphanAssets();
      setOrphanScan(res);
      if (res.total_files === 0) toast.success(t("settings.assetsNone"));
    } catch (e) {
      logger.error("scan orphan assets failed", e);
      toast.error(t("settings.assetsFailed", { message: String(e) }));
    } finally {
      setBusyAssets(false);
    }
  };

  /** 把扫描出的未引用资源移入备份目录（后端会按此刻的引用关系再筛一遍） */
  const purgeAssets = async () => {
    setBusyAssets(true);
    try {
      const res = await purgeOrphanAssets([]);
      toast.success(t("settings.assetsPurged", { n: String(res.moved), size: formatBytes(res.freed_bytes) }));
      setOrphanScan(null);
    } catch (e) {
      logger.error("purge orphan assets failed", e);
      toast.error(t("settings.assetsFailed", { message: String(e) }));
    } finally {
      setBusyAssets(false);
    }
  };

  return (
    <>
      <Section title={t("settings.assets")}>
        <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.assetsDesc")}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={scanAssets} disabled={busyAssets}>
            {busyAssets ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <HardDrive className="mr-1 h-3.5 w-3.5" />
            )}
            {busyAssets ? t("settings.assetsScanning") : t("settings.assetsScan")}
          </Button>
          {orphanScan && orphanScan.total_files > 0 && (
            <Button size="sm" variant="outline" onClick={() => setPurgeAssetsOpen(true)} disabled={busyAssets}>
              {t("settings.assetsPurge")}
            </Button>
          )}
        </div>
        {orphanScan && (
          <div className="mt-3 text-[11px] text-neutral-500">
            {orphanScan.total_files === 0
              ? t("settings.assetsNone")
              : t("settings.assetsFound", {
                  n: String(orphanScan.total_files),
                  size: formatBytes(orphanScan.total_bytes),
                })}
          </div>
        )}
      </Section>

      {/* 清理是「移动到备份目录」而非删除，故不做成危险操作样式 */}
      <ConfirmDialog
        open={purgeAssetsOpen}
        onOpenChange={setPurgeAssetsOpen}
        danger={false}
        title={t("settings.assets")}
        description={t("settings.assetsPurgeConfirm", { n: String(orphanScan?.total_files ?? 0) })}
        confirmLabel={t("settings.assetsPurge")}
        onConfirm={purgeAssets}
      />
    </>
  );
}
