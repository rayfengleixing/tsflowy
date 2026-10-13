import {
  useSettingsStore,
  ACCENT_PRESETS,
  FONT_SIZE_PRESETS,
  LINE_HEIGHT_PRESETS,
  EDITOR_WIDTH_PRESETS,
  THEME_PRESET_IDS,
  type FontFamily,
  type FontSize,
  type LineHeight,
  type EditorWidth,
} from "@/stores/settings";
import { t, LANGUAGES, type LangCode } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ACCENT_HEX, Section, Row, ThemeGroup, ThemePresetCard, isPreviewDark } from "./settings-parts";

/** 外观与语言：主题/预设/强调色/字体/行高/页宽/语言（全部走 settings store） */
export function SettingsAppearance() {
  // 原子 selector 订阅：避免全量订阅导致任意设置变更都重渲染本区块
  const theme = useSettingsStore((s) => s.theme);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const accent = useSettingsStore((s) => s.accent);
  const font = useSettingsStore((s) => s.font);
  const lang = useSettingsStore((s) => s.lang);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const editorWidth = useSettingsStore((s) => s.editorWidth);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setThemePreset = useSettingsStore((s) => s.setThemePreset);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const setFont = useSettingsStore((s) => s.setFont);
  const setLang = useSettingsStore((s) => s.setLang);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setLineHeight = useSettingsStore((s) => s.setLineHeight);
  const setEditorWidth = useSettingsStore((s) => s.setEditorWidth);

  return (
    <Section title={t("settings.appearance")}>
      <Row label={t("settings.theme")}>
        <ThemeGroup value={theme} onChange={setTheme} />
      </Row>
      <Row label={t("settings.themePreset")}>
        <div className="flex flex-wrap justify-end gap-2">
          {THEME_PRESET_IDS.map((id) => (
            <ThemePresetCard
              key={id}
              id={id}
              selected={themePreset === id}
              dark={isPreviewDark(theme)}
              onSelect={setThemePreset}
            />
          ))}
        </div>
      </Row>
      <p className="-mt-1 text-right text-[11px] text-neutral-400">{t("settings.themePresetHint")}</p>
      <Row label={t("settings.accent")}>
        <div className="flex items-center gap-2">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => setAccent(c)}
              className={cn(
                "h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-white transition",
                accent === c ? "ring-neutral-700" : "ring-transparent hover:ring-neutral-300",
              )}
              style={{ backgroundColor: ACCENT_HEX[c] }}
              aria-label={c}
            />
          ))}
        </div>
      </Row>
      <Row label={t("settings.font")}>
        <select
          value={font}
          onChange={(e) => setFont(e.target.value as FontFamily)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
        >
          <option value="sans">{t("settings.fontSans")}</option>
          <option value="serif">{t("settings.fontSerif")}</option>
          <option value="mono">{t("settings.fontMono")}</option>
        </select>
      </Row>
      <Row label={t("settings.fontSize")}>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 p-0.5">
          {FONT_SIZE_PRESETS.map((s) => {
            const labels: Record<FontSize, string> = {
              sm: t("settings.fontSizeSm"),
              md: t("settings.fontSizeMd"),
              lg: t("settings.fontSizeLg"),
              xl: t("settings.fontSizeXl"),
            };
            return (
              <button
                key={s}
                onClick={() => setFontSize(s)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition",
                  fontSize === s ? "bg-brand-500 text-white shadow" : "text-neutral-600 hover:bg-neutral-100",
                )}
              >
                {labels[s]}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t("settings.lineHeight")}>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 p-0.5">
          {LINE_HEIGHT_PRESETS.map((lh) => {
            const labels: Record<LineHeight, string> = {
              compact: t("settings.lineHeightCompact"),
              normal: t("settings.lineHeightNormal"),
              loose: t("settings.lineHeightLoose"),
            };
            return (
              <button
                key={lh}
                onClick={() => setLineHeight(lh)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition",
                  lineHeight === lh ? "bg-brand-500 text-white shadow" : "text-neutral-600 hover:bg-neutral-100",
                )}
              >
                {labels[lh]}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t("settings.editorWidth")}>
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 p-0.5">
          {EDITOR_WIDTH_PRESETS.map((w) => {
            const labels: Record<EditorWidth, string> = {
              narrow: t("settings.editorWidthNarrow"),
              default: t("settings.editorWidthDefault"),
              wide: t("settings.editorWidthWide"),
              xwide: t("settings.editorWidthXwide"),
            };
            return (
              <button
                key={w}
                onClick={() => setEditorWidth(w)}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition",
                  editorWidth === w ? "bg-brand-500 text-white shadow" : "text-neutral-600 hover:bg-neutral-100",
                )}
              >
                {labels[w]}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t("settings.language")}>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as LangCode)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  );
}
