import { useRef, useState } from "react";
import { DownloadCloud, RefreshCw } from "lucide-react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { Section, updateErrorMessage } from "./settings-parts";

/** 软件更新：自动更新检查/下载/安装 */
export function SettingsUpdates() {
  // 自动更新：idle → checking → available → downloading → installing
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "available" | "downloading" | "installing">(
    "idle",
  );
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const updateRef = useRef<Awaited<ReturnType<typeof check>> | null>(null);

  const checkForUpdates = async () => {
    setUpdateState("checking");
    try {
      const update = await check();
      if (!update) {
        setUpdateState("idle");
        toast.success(t("settings.upToDate"));
        return;
      }
      updateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateState("available");
    } catch (e) {
      setUpdateState("idle");
      logger.error("check update failed", e);
      toast.error(updateErrorMessage(e));
    }
  };

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update) return;
    try {
      setUpdateState("downloading");
      await update.downloadAndInstall((event) => {
        if (event.event === "Finished") setUpdateState("installing");
      });
      await relaunch();
    } catch (e) {
      setUpdateState("available");
      logger.error("install update failed", e);
      toast.error(updateErrorMessage(e));
    }
  };

  return (
    <Section title={t("settings.updates")}>
      <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.updateDesc")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={checkForUpdates}
          disabled={updateState === "checking" || updateState === "downloading" || updateState === "installing"}
        >
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", updateState === "checking" && "animate-spin")} />
          {updateState === "checking" ? t("settings.updateChecking") : t("settings.checkUpdate")}
        </Button>
        {updateState === "available" && (
          <Button size="sm" onClick={installUpdate}>
            <DownloadCloud className="mr-1 h-3.5 w-3.5" />
            {t("settings.updateInstall")}
          </Button>
        )}
        <span className="text-xs text-neutral-500">
          {updateState === "available" && updateVersion
            ? t("settings.updateAvailable", { version: updateVersion })
            : null}
          {updateState === "downloading" ? t("settings.updateDownloading") : null}
          {updateState === "installing" ? t("settings.updateInstalling") : null}
        </span>
      </div>
    </Section>
  );
}
