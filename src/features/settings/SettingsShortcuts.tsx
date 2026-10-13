import { t } from "@/lib/i18n";
import { Section, ResetAllShortcuts, ShortcutRecorder, type ShortcutGroup } from "./settings-parts";

/** 快捷键总览：只读展示 + 可自定义项的录制入口（状态在 shortcuts store） */
export function SettingsShortcuts() {
  const shortcutGroups: ShortcutGroup[] = [
    {
      titleKey: t("settings.shortcuts.global"),
      customizable: true,
      items: [
        { label: t("settings.shortcuts.commandPalette"), id: "commandPalette" },
        { label: t("settings.shortcuts.quickOpen"), id: "quickOpen" },
        { label: t("settings.shortcuts.search"), id: "search" },
        { label: t("settings.shortcuts.switchTab"), id: "switchTab" },
        { label: t("settings.shortcuts.escape"), key: "Esc" },
        { label: t("settings.shortcuts.save"), key: "Ctrl / ⌘ + S" },
      ],
    },
    {
      titleKey: t("settings.shortcuts.editor"),
      customizable: true,
      items: [
        { label: t("settings.shortcuts.slash"), key: "/" },
        { label: t("settings.shortcuts.bold"), id: "bold" },
        { label: t("settings.shortcuts.italic"), id: "italic" },
        { label: t("settings.shortcuts.underline"), id: "underline" },
        { label: t("settings.shortcuts.strike"), id: "strike" },
        { label: t("settings.shortcuts.undo"), id: "undo" },
        { label: t("settings.shortcuts.redo"), id: "redo" },
      ],
    },
  ];

  return (
    <Section title={t("settings.shortcuts")}>
      <div className="space-y-5">
        <p className="max-w-lg text-[11px] leading-relaxed text-neutral-500">{t("settings.shortcutHint")}</p>
        {shortcutGroups.map((g) => (
          <div key={g.titleKey}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{g.titleKey}</h3>
              {g.customizable ? <ResetAllShortcuts /> : null}
            </div>
            <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 text-xs">
              {g.items.map((item) => (
                <li key={item.label} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-neutral-700">{item.label}</span>
                  {item.id ? (
                    <ShortcutRecorder id={item.id} />
                  ) : (
                    <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 shadow-sm">
                      {item.key}
                    </kbd>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
