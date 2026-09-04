import { useEffect, useState } from "react";
import { FolderOpen, Upload, Download, Settings2, RefreshCw, FolderInput } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import {
  useSettingsStore,
  ACCENT_PRESETS,
  FONT_SIZE_PRESETS,
  LINE_HEIGHT_PRESETS,
  type ThemeMode,
  type AccentColor,
  type FontFamily,
  type FontSize,
  type LineHeight,
} from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { Button } from "@/components/ui/button";
import { importMarkdownFolder } from "@/lib/import-folder";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const ACCENT_HEX: Record<AccentColor, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#ea580c",
  purple: "#9333ea",
  red: "#dc2626",
  yellow: "#ca8a04",
};

interface ShortcutGroup {
  titleKey: string;
  items: { label: string; key: string }[];
}

/** 设置页（M6）：外观/语言/数据目录/备份/快捷键 */
export function SettingsPage() {
  const {
    theme,
    accent,
    font,
    lang,
    fontSize,
    lineHeight,
    setTheme,
    setAccent,
    setFont,
    setLang,
    setFontSize,
    setLineHeight,
  } = useSettingsStore();

  const [dataDir, setDataDir] = useState<string>("");
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyImportFolder, setBusyImportFolder] = useState(false);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  useEffect(() => {
    invoke<string>("data_dir_path")
      .then(setDataDir)
      .catch((e) => console.error("failed to get data dir", e));
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

  const openDataDir = async () => {
    try {
      await invoke<void>("open_data_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
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

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
