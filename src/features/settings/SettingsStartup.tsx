import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  crashRestartEnabled,
  getAutostartState,
  setAutostart,
  setCrashRestartEnabled,
  type AutostartState,
} from "@/lib/desktop/app-shell";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section } from "./settings-parts";

/**
 * 开机与崩溃：登录自启（当前用户注册表启动项）+ 崩溃后自动重启。
 * 自启的正本在注册表里，不在本机任何应用存储中，所以每次进设置都现读一遍。
 */
export function SettingsStartup() {
  const [autostart, setAutostartState] = useState<AutostartState | null>(null);
  const [crashRestart, setCrashRestart] = useState(crashRestartEnabled());

  useEffect(() => {
    getAutostartState()
      .then(setAutostartState)
      .catch((e: unknown) => logger.warn("startup", "autostart state read failed", e));
  }, []);

  const toggleAutostart = async (on: boolean) => {
    const previous = autostart;
    // 先按预期值回显，再以注册表读回的结果覆盖：写成功时界面与注册表始终一致
    if (previous) setAutostartState({ ...previous, enabled: on });
    try {
      await setAutostart(on);
      setAutostartState(await getAutostartState());
    } catch (e) {
      if (previous) setAutostartState(previous);
      logger.warn("startup", "autostart write failed", e);
      toast.error(t("error.autostart", { message: String(e) }));
    }
  };

  return (
    <Section title={t("settings.startup")}>
      <div>
        <label
          className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200"
          aria-disabled={autostart?.unavailable ? true : undefined}
        >
          <input
            type="checkbox"
            checked={autostart?.enabled ?? false}
            disabled={autostart?.unavailable ?? false}
            onChange={(e) => void toggleAutostart(e.target.checked)}
          />
          {t("settings.autostart")}
        </label>
        <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-neutral-400">{t("settings.autostartDesc")}</p>
        {autostart?.unavailable ? (
          <p className="mt-1.5 max-w-lg rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t("settings.autostartUnavailable")}
          </p>
        ) : null}
        {autostart && !autostart.unavailable ? (
          <p className="mt-1 max-w-lg truncate font-mono text-[10px] text-neutral-400">
            {t("settings.autostartCommand", { command: autostart.command })}
          </p>
        ) : null}
      </div>

      <div>
        <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
          <input
            type="checkbox"
            checked={crashRestart}
            onChange={(e) => {
              setCrashRestart(e.target.checked);
              setCrashRestartEnabled(e.target.checked);
            }}
          />
          {t("settings.crashRestart")}
        </label>
        <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-neutral-400">{t("settings.crashRestartDesc")}</p>
      </div>
    </Section>
  );
}
