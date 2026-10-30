import { useState } from "react";
import { HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { scanOrphanAssets, purgeOrphanAssets, type OrphanScan } from "@/lib/assets/assets";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section, formatBytes } from "./settings-parts";

/** 未引用附件：扫描 assets/ 孤儿文件，确认后移入备份目录（非删除） */
export function SettingsAssets() {
  // scan 为 null 表示本次进入设置页后还没扫描过
  const [orphanScan, setOrphanScan] = useState<OrphanScan | null>(null);
  const [busyAssets, setBusyAssets] = useState(false);
  const [purgeAssetsOpen, setPurgeAssetsOpen] = useState(false);
  // 非空表示「只清这一个文件」的确认框打开着；一次只处理一个，避免误勾一片
  const [pendingOne, setPendingOne] = useState<string | null>(null);

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

  /**
   * 把指定文件名挪进备份目录（传空数组 = 全部）。
   * 后端按此刻的引用关系再筛一遍，所以清理完必须重扫，不能让界面停在旧清单上。
   */
  const purge = async (names: string[]) => {
    setBusyAssets(true);
    try {
      const res = await purgeOrphanAssets(names);
      toast.success(t("settings.assetsPurged", { n: String(res.moved), size: formatBytes(res.freed_bytes) }));
      const after = await scanOrphanAssets();
      setOrphanScan(after);
    } catch (e) {
      logger.error("purge orphan assets failed", e);
      toast.error(t("settings.assetsFailed", { message: String(e) }));
    } finally {
      setBusyAssets(false);
    }
  };

  const files = orphanScan?.files ?? [];

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

        {/* 逐条列出：整库清理之外还要能只挪走某一个文件（大附件误留在盘上时不必全清） */}
        {files.length > 0 && (
          <ul className="mt-3 max-h-64 w-full max-w-lg overflow-auto rounded-md border border-neutral-200">
            {files.map((f) => (
              <li
                key={f.name}
                className="flex items-center gap-2 border-b border-neutral-100 px-2 py-1.5 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-700" title={f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 text-[11px] text-neutral-500">{formatBytes(f.bytes)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-1.5"
                  disabled={busyAssets}
                  onClick={() => setPendingOne(f.name)}
                  aria-label={t("settings.assetsPurge")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
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
        onConfirm={() => void purge([])}
      />

      <ConfirmDialog
        open={pendingOne !== null}
        onOpenChange={(v) => {
          if (!v) setPendingOne(null);
        }}
        danger={false}
        title={t("settings.assets")}
        description={t("settings.assetsPurgeOneConfirm", { name: pendingOne ?? "" })}
        confirmLabel={t("settings.assetsPurge")}
        onConfirm={() => {
          const name = pendingOne;
          setPendingOne(null);
          if (name) void purge([name]);
        }}
      />
    </>
  );
}
