import { formatCombo, useShortcutsStore, type ShortcutId } from "@/lib/shortcuts";
import { t } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings";
import { Section, Row } from "./settings-parts";

/** 编辑器模式：只读 / 专注 / 打字机（开关走 settings store，快捷键在下方快捷键区块自定义） */
export function SettingsEditorModes() {
  const editorReadonly = useSettingsStore((s) => s.editorReadonly);
  const focusMode = useSettingsStore((s) => s.focusMode);
  const typewriter = useSettingsStore((s) => s.typewriter);
  const setEditorReadonly = useSettingsStore((s) => s.setEditorReadonly);
  const setFocusMode = useSettingsStore((s) => s.setFocusMode);
  const setTypewriter = useSettingsStore((s) => s.setTypewriter);

  return (
    <Section title={t("settings.editorModes")}>
      <ModeRow
        label={t("settings.modeReadonly")}
        desc={t("settings.modeReadonlyDesc")}
        checked={editorReadonly}
        onChange={setEditorReadonly}
        shortcutId="toggleReadonly"
      />
      <ModeRow
        label={t("settings.modeFocus")}
        desc={t("settings.modeFocusDesc")}
        checked={focusMode}
        onChange={setFocusMode}
        shortcutId="toggleFocus"
      />
      <ModeRow
        label={t("settings.modeTypewriter")}
        desc={t("settings.modeTypewriterDesc")}
        checked={typewriter}
        onChange={setTypewriter}
        shortcutId="toggleTypewriter"
      />
    </Section>
  );
}

function ModeRow({
  label,
  desc,
  checked,
  onChange,
  shortcutId,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  shortcutId: ShortcutId;
}) {
  // 快捷键跟着用户的自定义走，这里只展示当前生效的组合（改绑去下方「快捷键」区块）
  const combo = useShortcutsStore((s) => s.combos[shortcutId]);
  return (
    <div>
      <Row label={label}>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <kbd className="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[11px] text-neutral-500">
            {formatCombo(combo)}
          </kbd>
        </label>
      </Row>
      <p className="-mt-1 text-right text-[11px] text-neutral-400">{desc}</p>
    </div>
  );
}
