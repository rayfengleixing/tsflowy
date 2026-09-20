import { useEffect, useState } from "react";
import { FolderOpen, Upload, Download, Settings2, RefreshCw, FolderInput, FolderOutput } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import {
  useSettingsStore,
  ACCENT_PRESETS,
  FONT_SIZE_PRESETS,
  LINE_HEIGHT_PRESETS,
  EDITOR_WIDTH_PRESETS,
  THEME_PRESET_IDS,
  getPresetPreview,
  type ThemeMode,
  type ThemePresetId,
  type AccentColor,
  type FontFamily,
  type FontSize,
  type LineHeight,
  type EditorWidth,
} from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import { importMarkdownFolder } from "@/lib/import-folder";
import { exportMarkdownFolder } from "@/lib/export-folder";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";

const ACCENT_HEX: Record<AccentColor, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#ea580c",
  purple: "#9333ea",
  red: "#dc2626",
  yellow: "#ca8a04",
  slate: "#334155",
  rose: "#e11d48",
};

interface ShortcutGroup {
  titleKey: string;
  items: { label: string; key: string }[];
}

/** get_data_dir_info 返回结构（Rust 侧字段名即 JSON 键名） */
interface DataDirInfo {
  default: string;
  custom: string | null;
  will_change_after_restart: boolean;
}

/** change_data_dir / reset_data_dir_default 返回结构 */
interface ChangeDataDirResult {
  need_restart: boolean;
  copied: boolean;
}

/** 设置页（M6）：外观/语言/数据目录/备份/快捷键 */
export function SettingsPage() {
  const {
    theme,
    themePreset,
    accent,
    font,
    lang,
    fontSize,
    lineHeight,
    editorWidth,
    setTheme,
    setThemePreset,
    setAccent,
    setFont,
    setLang,
    setFontSize,
    setLineHeight,
    setEditorWidth,
  } = useSettingsStore();

  const [dataDir, setDataDir] = useState<string>("");
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [moveCurrent, setMoveCurrent] = useState(true);
  const [moveBack, setMoveBack] = useState(true);
  const [busyDir, setBusyDir] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyImportFolder, setBusyImportFolder] = useState(false);
  const [busyExportFolder, setBusyExportFolder] = useState(false);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  useEffect(() => {
    invoke<string>("data_dir_path")
      .then(setDataDir)
      .catch((e) => logger.error("failed to get data dir", e));
    refreshDataDirInfo();
  }, []);

  const shortcutGroups: ShortcutGroup[] = [
    {
      titleKey: t("settings.shortcuts.global"),
      items: [
        { label: t("settings.shortcuts.commandPalette"), key: "Ctrl / ⌘ + K" },
        { label: t("settings.shortcuts.search"), key: "Ctrl / ⌘ + Shift + F" },
        { label: t("settings.shortcuts.save"), key: "Ctrl / ⌘ + S" },
      ],
    },
    {
      titleKey: t("settings.shortcuts.editor"),
      items: [
        { label: t("settings.shortcuts.slash"), key: "/" },
        { label: t("settings.shortcuts.bold"), key: "Ctrl / ⌘ + B" },
        { label: t("settings.shortcuts.italic"), key: "Ctrl / ⌘ + I" },
        { label: t("settings.shortcuts.underline"), key: "Ctrl / ⌘ + U" },
        { label: t("settings.shortcuts.strike"), key: "Ctrl / ⌘ + Shift + X" },
        { label: t("settings.shortcuts.undo"), key: "Ctrl / ⌘ + Z" },
        { label: t("settings.shortcuts.redo"), key: "Ctrl / ⌘ + Shift + Z" },
      ],
    },
  ];

  const exportBackup = async () => {
    setBusyExport(true);
    try {
      const target = await save({
        defaultPath: `tsflowy-backup-${timestamp()}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!target) return;
      await invoke<void>("export_backup", { target_path: target });
      toast.success(t("settings.exported"));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyExport(false);
    }
  };

  const importBackup = async () => {
    const ok = window.confirm(`${t("settings.confirmImportTitle")}\n\n${t("settings.confirmImportDesc")}`);
    if (!ok) return;
    setBusyImport(true);
    try {
      const src = await open({
        multiple: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (typeof src !== "string") return;
      await invoke<void>("import_backup", { source_path: src });
      toast.success(t("settings.imported"));
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyImport(false);
    }
  };

  // 导入 Markdown 文件夹：遍历 .md → 按目录层级建页 → reload 刷树
  const importFolder = async () => {
    if (!currentWorkspaceId) return;
    setBusyImportFolder(true);
    try {
      const result = await importMarkdownFolder(currentWorkspaceId);
      if (result.total === 0) {
        toast.info(t("settings.importFolderEmpty"));
      } else {
        if (result.created > 0) toast.success(t("settings.importedFolder", { n: result.created }));
        if (result.failed > 0) toast.warning(t("settings.importFolderFailed", { n: result.failed }));
        await useWorkspaceStore.getState().reload();
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyImportFolder(false);
    }
  };

  // 整库导出 Markdown：按页面树递归导出 .md（有子页面的页面 → 同名文件夹）
  const exportFolder = async () => {
    setBusyExportFolder(true);
    try {
      const result = await exportMarkdownFolder();
      if (!result) return; // 用户取消
      if (result.total === 0) {
        toast.info(t("settings.exportFolderEmpty"));
      } else {
        if (result.exported > 0) toast.success(t("settings.exportedFolder", { n: result.exported }));
        if (result.failed > 0) toast.warning(t("settings.exportFolderFailed", { n: result.failed }));
      }
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    } finally {
      setBusyExportFolder(false);
    }
  };

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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">{t("settings.title")}</h1>
            <p className="text-xs text-neutral-500">TsFlowy · M6</p>
          </div>
        </header>

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
              onChange={(e) => setLang(e.target.value as "zh-CN" | "en-US")}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
            >
              <option value="zh-CN">{t("settings.langZh")}</option>
              <option value="en-US">{t("settings.langEn")}</option>
            </select>
          </Row>
        </Section>

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

        <Section title={t("settings.backup")}>
          <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.backupDesc")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={exportBackup} disabled={busyExport}>
              <Download className="mr-1 h-3.5 w-3.5" />
              {busyExport ? "…" : t("settings.exportBackup")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={importBackup}
              disabled={busyImport}
              className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-600"
            >
              {busyImport ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.importBackup")}
            </Button>
            <Button size="sm" variant="outline" onClick={importFolder} disabled={busyImportFolder}>
              {busyImportFolder ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderInput className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.importFolder")}
            </Button>
            <Button size="sm" variant="outline" onClick={exportFolder} disabled={busyExportFolder}>
              {busyExportFolder ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderOutput className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.exportFolder")}
            </Button>
          </div>
        </Section>

        <Section title={t("settings.shortcuts")}>
          <div className="space-y-5">
            {shortcutGroups.map((g) => (
              <div key={g.titleKey}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{g.titleKey}</h3>
                <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 text-xs">
                  {g.items.map((item) => (
                    <li key={item.label} className="flex items-center justify-between px-3 py-2">
                      <span className="text-neutral-700">{item.label}</span>
                      <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 shadow-sm">
                        {item.key}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-neutral-800">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ThemeGroup({ value, onChange }: { value: ThemeMode; onChange: (v: ThemeMode) => void }) {
  const options: { id: ThemeMode; label: string }[] = [
    { id: "light", label: t("settings.themeLight") },
    { id: "dark", label: t("settings.themeDark") },
    { id: "system", label: t("settings.themeSystem") },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded px-3 py-1 text-xs font-medium transition",
            value === o.id ? "bg-brand-500 text-white shadow" : "text-neutral-600 hover:bg-neutral-100",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const THEME_PRESET_LABEL_KEY: Record<ThemePresetId, MessageKey> = {
  appflowy: "settings.themePresetAppflowy",
  graphite: "settings.themePresetGraphite",
  forest: "settings.themePresetForest",
  violet: "settings.themePresetViolet",
  sunset: "settings.themePresetSunset",
  rose: "settings.themePresetRose",
};

/** 预览卡跟随当前生效的浅色/深色模式（system 取渲染时 matchMedia 结果） */
function isPreviewDark(theme: ThemeMode): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** 主题预设预览卡：迷你"侧边栏 + 内容区"示意图，所见即所选 */
function ThemePresetCard({
  id,
  selected,
  dark,
  onSelect,
}: {
  id: ThemePresetId;
  selected: boolean;
  dark: boolean;
  onSelect: (id: ThemePresetId) => void;
}) {
  const c = getPresetPreview(id, dark);
  return (
    <button
      onClick={() => onSelect(id)}
      className="group flex flex-col items-center gap-1.5"
      aria-label={t(THEME_PRESET_LABEL_KEY[id])}
      aria-pressed={selected}
    >
      <div
        className={cn(
          "flex h-14 w-[76px] overflow-hidden rounded-lg border transition",
          selected
            ? "border-transparent ring-2 ring-brand-500"
            : "border-neutral-200 group-hover:border-neutral-300 group-hover:ring-2 group-hover:ring-neutral-300",
        )}
        style={{ background: c.background, borderColor: c.border }}
      >
        <div
          className="flex w-5 shrink-0 flex-col gap-1 border-r p-1.5"
          style={{ background: c.sidebar, borderColor: c.border }}
        >
          <div className="h-1 rounded-full" style={{ background: c.foreground, opacity: 0.3 }} />
          <div className="h-1 w-2/3 rounded-full" style={{ background: c.foreground, opacity: 0.2 }} />
          <div className="h-1 w-3/4 rounded-full" style={{ background: c.foreground, opacity: 0.2 }} />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-1.5">
          <div className="h-1.5 w-1/2 rounded-full" style={{ background: c.accent }} />
          <div className="h-1 w-5/6 rounded-full" style={{ background: c.foreground, opacity: 0.3 }} />
          <div className="h-1 w-2/3 rounded-full" style={{ background: c.foreground, opacity: 0.2 }} />
        </div>
      </div>
      <span
        className={cn(
          "text-[10px] font-medium transition",
          selected ? "text-neutral-800 dark:text-neutral-200" : "text-neutral-500 dark:text-neutral-400",
        )}
      >
        {t(THEME_PRESET_LABEL_KEY[id])}
      </span>
    </button>
  );
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
