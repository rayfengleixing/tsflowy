import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { loadDailyNotesConfig, saveDailyNotesConfig, type DailyNotesConfig } from "@/lib/daily-notes";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Section, Row } from "./settings-parts";

/** 每日笔记：文件夹名/开机打开/模板（localStorage，无后端往返） */
export function SettingsDailyNotes() {
  const [daily, setDaily] = useState<DailyNotesConfig>(() => loadDailyNotesConfig());
  const openDailyNote = useWorkspaceStore((s) => s.openDailyNote);

  /** 每日笔记配置：改一项即存一项（localStorage，无后端往返） */
  const updateDaily = (patch: Partial<DailyNotesConfig>) => {
    const next = { ...daily, ...patch };
    setDaily(next);
    saveDailyNotesConfig(next);
  };

  const openTodayDailyNote = () => {
    openDailyNote().catch((e: unknown) => {
      logger.error("open daily note failed", e);
      toast.error(t("settings.dailyOpenFailed", { message: String(e) }));
    });
  };

  return (
    <Section title={t("settings.dailyNotes")}>
      <p className="max-w-lg text-xs text-neutral-500">{t("settings.dailyNotesDesc")}</p>
      <Row label={t("settings.dailyFolder")}>
        <input
          value={daily.folderName}
          onChange={(e) => updateDaily({ folderName: e.target.value })}
          className="h-7 w-56 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
      </Row>
      <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
        <input
          type="checkbox"
          checked={daily.openOnStart}
          onChange={(e) => updateDaily({ openOnStart: e.target.checked })}
        />
        {t("settings.dailyOpenOnStart")}
      </label>
      <div>
        <div className="mb-1.5 text-sm font-medium text-neutral-800">{t("settings.dailyTemplate")}</div>
        <textarea
          value={daily.template}
          onChange={(e) => updateDaily({ template: e.target.value })}
          rows={6}
          spellCheck={false}
          className="w-full max-w-lg resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
        />
        <p className="mt-1.5 max-w-lg text-[11px] text-neutral-500">{t("settings.dailyTemplateHint")}</p>
      </div>
      <div>
        <Button size="sm" variant="outline" onClick={openTodayDailyNote}>
          <CalendarDays className="mr-1 h-3.5 w-3.5" />
          {t("settings.dailyOpenNow")}
        </Button>
      </div>
    </Section>
  );
}
