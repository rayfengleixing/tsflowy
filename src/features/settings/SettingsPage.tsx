import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";

import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { SettingsUpdates } from "./SettingsUpdates";
import { SettingsAppearance } from "./SettingsAppearance";
import { SettingsEditorModes } from "./SettingsEditorModes";
import { SettingsDataDir } from "./SettingsDataDir";
import { SettingsBackup } from "./SettingsBackup";
import { SettingsDbHealth } from "./SettingsDbHealth";
import { SettingsAssets } from "./SettingsAssets";
import { SettingsSync } from "./SettingsSync";
import { SettingsDailyNotes } from "./SettingsDailyNotes";
import { SettingsAi } from "./SettingsAi";
import { SettingsShortcuts } from "./SettingsShortcuts";
import { SettingsStartup } from "./SettingsStartup";

/**
 * 设置页（M6）：只负责页头与区块编排。
 * 各区块（更新/开机与崩溃/外观/编辑器模式/数据目录/备份/数据库健康/资源/同步/每日笔记/AI/快捷键）拆成独立组件，
 * 各自持有状态与拉取——一个区块的输入/保存不再重渲染整页。
 */
export function SettingsPage() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((e: unknown) => logger.error("failed to get app version", e));
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">{t("settings.title")}</h1>
            <p className="text-xs text-neutral-500">{version ? `TsFlowy · v${version}` : "TsFlowy"}</p>
          </div>
        </header>

        <SettingsUpdates />
        <SettingsStartup />
        <SettingsAppearance />
        <SettingsEditorModes />
        <SettingsDataDir />
        <SettingsBackup />
        <SettingsDbHealth />
        <SettingsAssets />
        <SettingsSync />
        <SettingsDailyNotes />
        <SettingsAi />
        <SettingsShortcuts />
      </div>
    </div>
  );
}
