import { t } from "@/lib/i18n";
import { EDITOR_SHORTCUT_IDS, GLOBAL_SHORTCUT_IDS, shortcutLabelKey, type ShortcutId } from "@/lib/desktop/shortcuts";
import { Section, ResetAllShortcuts, ShortcutRecorder, type ShortcutGroup, type ShortcutItem } from "./settings-parts";
import { SettingsCaptureShortcut } from "./SettingsCaptureShortcut";

/** 可自定义命令的清单直接由 shortcuts.ts 的分组生成：新增命令不用再在这里补一行（漏抄就等于少一个改绑入口） */
function itemsOf(ids: ShortcutId[]): ShortcutItem[] {
  return ids.map((id) => ({ label: t(shortcutLabelKey(id)), id }));
}

/** 快捷键总览：只读展示 + 可自定义项的录制入口（状态在 shortcuts store） */
export function SettingsShortcuts() {
  const shortcutGroups: ShortcutGroup[] = [
    {
      titleKey: t("settings.shortcuts.global"),
      customizable: true,
      items: [
        ...itemsOf(GLOBAL_SHORTCUT_IDS),
        // 固定不可改的两条：Esc 收浮层、Ctrl+S 手动保存
        { label: t("settings.shortcuts.escape"), key: "Esc" },
        { label: t("settings.shortcuts.save"), key: "Ctrl / ⌘ + S" },
      ],
    },
    {
      titleKey: t("settings.shortcuts.editor"),
      customizable: true,
      items: [{ label: t("settings.shortcuts.slash"), key: "/" }, ...itemsOf(EDITOR_SHORTCUT_IDS)],
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
        {/* 系统级那一条不在 shortcuts store 里：它由 Rust 注册给操作系统，改了立刻换绑 */}
        <SettingsCaptureShortcut />
      </div>
    </Section>
  );
}
