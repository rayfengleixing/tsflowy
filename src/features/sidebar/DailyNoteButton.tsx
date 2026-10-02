import { useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettingsStore } from "@/stores/settings";
import { parseDateKey, shiftDateKey, shortDateKey, toDateKey, weekdayLabel } from "@/lib/daily-notes";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

/** 侧边栏「今日笔记」：整行按钮一键打开今天，右侧小箭头可挑任意日期 */
export function DailyNoteButton() {
  const openDailyNote = useWorkspaceStore((s) => s.openDailyNote);
  const lang = useSettingsStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  const today = toDateKey(new Date());
  const [picked, setPicked] = useState(today);

  const openNote = (key: string) => {
    const date = parseDateKey(key);
    if (!date) return;
    setOpen(false);
    openDailyNote(date).catch((e: unknown) => {
      logger.error("DailyNoteButton", "open daily note failed", key, e);
      toast.error(t("daily.failed", { message: String(e) }));
    });
  };

  const pickedDate = parseDateKey(picked);

  return (
    <div className="flex h-[30px] items-center rounded-md text-[13px] text-neutral-600 hover:bg-neutral-300/60">
      <button
        data-testid="daily-note"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left"
        title={t("daily.openToday")}
        onClick={() => openNote(today)}
      >
        <CalendarDays className="h-4 w-4 shrink-0" />
        <span className="truncate">{t("daily.today")}</span>
      </button>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setPicked(today);
        }}
      >
        <PopoverTrigger asChild>
          <button
            data-testid="daily-note-picker"
            className="flex h-full items-center gap-1 rounded-md px-1.5 text-[11px] text-neutral-500 hover:bg-neutral-300/70"
            title={t("daily.pickDate")}
          >
            <span className="tabular-nums">{shortDateKey(today)}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 gap-2">
          <Input type="date" value={picked} onChange={(e) => setPicked(e.target.value)} className="h-8 text-[12px]" />
          <p className="text-[11px] text-neutral-500">
            {pickedDate ? `${picked} ${weekdayLabel(pickedDate, lang)}` : t("daily.badDate")}
          </p>
          <div className="flex items-center gap-1">
            <button
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-[12px] hover:bg-neutral-100"
              onClick={() => openNote(shiftDateKey(picked, -1))}
            >
              {t("daily.prevDay")}
            </button>
            <button
              className="flex-1 rounded-md bg-brand-500 px-2 py-1 text-[12px] font-medium text-white hover:bg-brand-600"
              onClick={() => openNote(picked)}
            >
              {t("daily.open")}
            </button>
            <button
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-[12px] hover:bg-neutral-100"
              onClick={() => openNote(shiftDateKey(picked, 1))}
            >
              {t("daily.nextDay")}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
