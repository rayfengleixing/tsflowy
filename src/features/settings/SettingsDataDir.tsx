import { useEffect, useState } from "react";
import { FolderInput, FolderOpen, RefreshCw } from "lucide-react";
import { invoke } from "@/lib/invoke";
import { open } from "@/lib/ipc-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { detectDataDirRisk } from "@/lib/data-dir-risk";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section, RiskNotice, type DataDirInfo, type ChangeDataDirResult, type SyncInfo } from "./settings-parts";

/** 数据目录：查看/迁移/恢复默认（迁移下次启动生效），并提示云盘/同步嵌套风险 */
export function SettingsDataDir() {
  const [dataDir, setDataDir] = useState<string>("");
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [moveCurrent, setMoveCurrent] = useState(true);
  const [moveBack, setMoveBack] = useState(true);
  const [busyDir, setBusyDir] = useState(false);
  // 仅为风险检测拉取同步文件夹；本区块不管理同步状态（改同步目录后此处提示到下次进入设置页才更新）
  const [syncDir, setSyncDir] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    invoke<string>("data_dir_path")
      .then(setDataDir)
      .catch((e: unknown) => logger.error("failed to get data dir", e));
    invoke<SyncInfo>("get_sync_info")
      .then((info) => setSyncDir(info.dir))
      .catch((e: unknown) => logger.error("failed to get sync info", e));
    refreshDataDirInfo();
  }, []);

  // 数据目录风险：位于云同步盘内，或与同步文件夹互相嵌套
  const dataDirRisk = detectDataDirRisk(dataDir, syncDir);

  const openDataDir = async () => {
    try {
      await invoke<void>("open_data_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const refreshDataDirInfo = () => {
    invoke<DataDirInfo>("get_data_dir_info")
      .then(setDataDirInfo)
      .catch((e: unknown) => logger.error("failed to get data dir info", e));
  };

  /** 选新目录 → change_data_dir（下次启动生效；可勾选把现有数据复制过去） */
  const chooseDataDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setBusyDir(true);
    try {
      await invoke<ChangeDataDirResult>("change_data_dir", { newPath: picked, moveCurrent });
      toast.success(t("settings.changeDirOk"));
      refreshDataDirInfo();
    } catch (e) {
      logger.error("change data dir failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyDir(false);
    }
  };

  /** 恢复默认数据目录（可勾选把自定义目录最新数据复制回默认位置） */
  const resetDataDir = async () => {
    setBusyDir(true);
    try {
      const r = await invoke<ChangeDataDirResult>("reset_data_dir_default", { moveBack });
      if (r.need_restart) toast.success(t("settings.resetDirOk"));
      refreshDataDirInfo();
    } catch (e) {
      logger.error("reset data dir failed", e);
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyDir(false);
    }
  };

  return (
    <Section title={t("settings.dataDir")}>
      <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.dataDirHint")}</p>
      <div className="mb-1 text-[11px] text-neutral-500">{t("settings.dataDirEffective")}</div>
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={dataDir}
          className="flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 font-mono text-[11px] text-neutral-700 outline-none"
        />
        <Button size="sm" onClick={openDataDir}>
          <FolderOpen className="mr-1 h-3.5 w-3.5" />
          {t("settings.openDir")}
        </Button>
      </div>
      {dataDirInfo && (
        <div className="mt-1.5 text-[11px] text-neutral-500">
          {dataDirInfo.is_linked
            ? t("settings.dataDirLinked", { path: dataDirInfo.link_path })
            : t("settings.dataDirPlain")}
        </div>
      )}
      <RiskNotice risk={dataDirRisk} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
          <input type="checkbox" checked={moveCurrent} onChange={(e) => setMoveCurrent(e.target.checked)} />
          {t("settings.moveCurrentData")}
        </label>
        <Button size="sm" variant="outline" onClick={chooseDataDir} disabled={busyDir}>
          <FolderInput className="mr-1 h-3.5 w-3.5" />
          {t("settings.chooseDir")}
        </Button>
      </div>
      {dataDirInfo?.custom && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-[11px] text-neutral-500">
            {t("settings.dataDirCustom")}：<span className="font-mono">{dataDirInfo.custom}</span>
            {dataDirInfo.will_change_after_restart && (
              <span className="ml-1 text-amber-600">{t("settings.willChangeHint")}</span>
            )}
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            <input type="checkbox" checked={moveBack} onChange={(e) => setMoveBack(e.target.checked)} />
            {t("settings.moveBackData")}
          </label>
          <Button size="sm" variant="outline" onClick={resetDataDir} disabled={busyDir}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t("settings.resetDir")}
          </Button>
        </div>
      )}
    </Section>
  );
}
