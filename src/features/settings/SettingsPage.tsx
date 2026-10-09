import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  FolderOpen,
  Upload,
  Download,
  Settings2,
  RefreshCw,
  FolderInput,
  FolderOutput,
  DownloadCloud,
  HardDrive,
  Sparkles,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { save, open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

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
import { useWorkspaceStore } from "@/stores/workspace";
import { useAiStore } from "@/stores/ai";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { scanOrphanAssets, purgeOrphanAssets, type OrphanScan } from "@/lib/assets";
import { detectDataDirRisk } from "@/lib/data-dir-risk";
import { importMarkdownFolder } from "@/lib/import-folder";
import { loadDailyNotesConfig, saveDailyNotesConfig, type DailyNotesConfig } from "@/lib/daily-notes";
import { exportMarkdownFolder } from "@/lib/export-folder";
import { flushAllForClose } from "@/lib/close-flush";
import { loadAutoSyncConfig, saveAutoSyncConfig, type AutoSyncConfig } from "@/lib/auto-sync";
import { aiGetConfig, aiSaveConfig, aiTestConnection, AI_PROVIDER_PRESETS, type AiConfig } from "@/lib/ai";
import { t, LANGUAGES, type LangCode } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import {
  ACCENT_HEX,
  SYNC_ACTION_KEY,
  AI_PROVIDER_LABEL_KEY,
  updateErrorMessage,
  formatBytes,
  isPreviewDark,
  timestamp,
  RiskNotice,
  ShortcutRecorder,
  ResetAllShortcuts,
  Section,
  Row,
  ThemeGroup,
  ThemePresetCard,
  type ShortcutGroup,
  type DataDirInfo,
  type ChangeDataDirResult,
  type AutoBackupInfo,
  type SyncInfo,
  type SyncRunResult,
  type ConflictFile,
  type AiFormState,
} from "./settings-parts";

/** 设置页（M6）：外观/语言/数据目录/备份/快捷键 */
export function SettingsPage() {
  // 原子 selector 订阅：避免 useSettingsStore() 全量订阅导致任意设置变更都重渲染整个设置页
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

  const [dataDir, setDataDir] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [moveCurrent, setMoveCurrent] = useState(true);
  const [moveBack, setMoveBack] = useState(true);
  const [busyDir, setBusyDir] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [busyImportFolder, setBusyImportFolder] = useState(false);
  const [busyExportFolder, setBusyExportFolder] = useState(false);
  const [autoBackup, setAutoBackup] = useState<AutoBackupInfo | null>(null);
  const [busyBackupNow, setBusyBackupNow] = useState(false);
  // 未引用资源清理：scan 为 null 表示本次进入设置页后还没扫描过
  const [orphanScan, setOrphanScan] = useState<OrphanScan | null>(null);
  const [busyAssets, setBusyAssets] = useState(false);
  const [purgeAssetsOpen, setPurgeAssetsOpen] = useState(false);
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [busySync, setBusySync] = useState(false);
  // 冲突副本列表（进入同步区块时拉取；恢复/打开目录后刷新）
  const [conflictFiles, setConflictFiles] = useState<ConflictFile[]>([]);
  // 待确认恢复的冲突副本（恢复会替换本机库，先确认）
  const [restoreTarget, setRestoreTarget] = useState<ConflictFile | null>(null);
  // 同步自动化选项（localStorage，见 lib/auto-sync.ts）
  const [autoSync, setAutoSync] = useState<AutoSyncConfig>(() => loadAutoSyncConfig());
  // 自动更新：idle → checking → available → downloading → installing
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "available" | "downloading" | "installing">(
    "idle",
  );
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const updateRef = useRef<Awaited<ReturnType<typeof check>> | null>(null);
  const [daily, setDaily] = useState<DailyNotesConfig>(() => loadDailyNotesConfig());
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [aiForm, setAiForm] = useState<AiFormState>({
    enabled: false,
    provider: "custom",
    baseUrl: "",
    model: "",
    maxChars: 8000,
  });
  const [aiApiKey, setAiApiKey] = useState("");
  const [busyAiTest, setBusyAiTest] = useState(false);
  const openDailyNote = useWorkspaceStore((s) => s.openDailyNote);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  // 上次同步动作对应的文案 key；未知动作返回 undefined（不渲染）
  const syncLastActionKey = syncInfo?.last_action ? SYNC_ACTION_KEY[syncInfo.last_action] : undefined;
  // 数据目录风险：位于云同步盘内，或与同步文件夹互相嵌套
  const dataDirRisk = detectDataDirRisk(dataDir, syncInfo?.dir);

  useEffect(() => {
    invoke<string>("data_dir_path")
      .then(setDataDir)
      .catch((e: unknown) => logger.error("failed to get data dir", e));
    getVersion()
      .then(setVersion)
      .catch((e: unknown) => logger.error("failed to get app version", e));
    refreshDataDirInfo();
    refreshAutoBackup();
    refreshSyncInfo();
    // AI 配置（内联拉取：避免把 refreshAiConfig 引入 effect 依赖）
    aiGetConfig()
      .then((c) => {
        applyAiConfig(c);
        useAiStore.getState().setConfig(c);
      })
      .catch((e: unknown) => logger.error("failed to get ai config", e));
  }, []);

  const checkForUpdates = async () => {
    setUpdateState("checking");
    try {
      const update = await check();
      if (!update) {
        setUpdateState("idle");
        toast.success(t("settings.upToDate"));
        return;
      }
      updateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateState("available");
    } catch (e) {
      setUpdateState("idle");
      logger.error("check update failed", e);
      toast.error(updateErrorMessage(e));
    }
  };

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update) return;
    try {
      setUpdateState("downloading");
      await update.downloadAndInstall((event) => {
        if (event.event === "Finished") setUpdateState("installing");
      });
      await relaunch();
    } catch (e) {
      setUpdateState("available");
      logger.error("install update failed", e);
      toast.error(updateErrorMessage(e));
    }
  };

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

  const exportBackup = async () => {
    setBusyExport(true);
    try {
      const target = await save({
        defaultPath: `tsflowy-backup-${timestamp()}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!target) return;
      await invoke<void>("export_backup", { targetPath: target });
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
      await invoke<void>("import_backup", { sourcePath: src });
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

  const refreshAutoBackup = () => {
    invoke<AutoBackupInfo>("get_auto_backup_config")
      .then(setAutoBackup)
      .catch((e: unknown) => logger.error("failed to get auto backup config", e));
  };

  /** 三项一起写回（Rust 侧命令接收完整配置），成功后用返回值刷新展示 */
  const persistAutoBackup = async (next: AutoBackupInfo) => {
    setAutoBackup(next); // 乐观更新，输入框即时响应
    try {
      const saved = await invoke<AutoBackupInfo>("set_auto_backup_config", {
        enabled: next.enabled,
        intervalHours: next.interval_hours,
        keep: next.keep,
      });
      setAutoBackup(saved);
    } catch (e) {
      logger.error("save auto backup config failed", e);
      toast.error(t("error.db", { message: String(e) }));
      refreshAutoBackup();
    }
  };

  /** 立即备份一次（与自动备份同一链路，写入数据目录的 backups/） */
  const backupNow = async () => {
    setBusyBackupNow(true);
    try {
      await invoke<string>("run_auto_backup_now");
      toast.success(t("settings.autoBackupDone"));
      refreshAutoBackup();
    } catch (e) {
      logger.error("run auto backup failed", e);
      toast.error(`${t("settings.autoBackupFailed")}：${String(e)}`);
    } finally {
      setBusyBackupNow(false);
    }
  };

  /** 扫描 assets/ 下不再被引用的资源（只读，不动磁盘） */
  const scanAssets = async () => {
    setBusyAssets(true);
    try {
      const res = await scanOrphanAssets();
      setOrphanScan(res);
      if (res.total_files === 0) toast.success(t("settings.assetsNone"));
    } catch (e) {
      logger.error("scan orphan assets failed", e);
      toast.error(t("settings.assetsFailed", { message: String(e) }));
    } finally {
      setBusyAssets(false);
    }
  };

  /** 把扫描出的未引用资源移入备份目录（后端会按此刻的引用关系再筛一遍） */
  const purgeAssets = async () => {
    setBusyAssets(true);
    try {
      const res = await purgeOrphanAssets([]);
      toast.success(t("settings.assetsPurged", { n: String(res.moved), size: formatBytes(res.freed_bytes) }));
      setOrphanScan(null);
    } catch (e) {
      logger.error("purge orphan assets failed", e);
      toast.error(t("settings.assetsFailed", { message: String(e) }));
    } finally {
      setBusyAssets(false);
    }
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

  const refreshSyncInfo = () => {
    invoke<SyncInfo>("get_sync_info")
      .then((info) => {
        setSyncInfo(info);
        if (info.dir) {
          invoke<ConflictFile[]>("list_sync_conflicts")
            .then(setConflictFiles)
            .catch((e: unknown) => logger.error("failed to list sync conflicts", e));
        } else {
          setConflictFiles([]);
        }
      })
      .catch((e: unknown) => logger.error("failed to get sync info", e));
  };

  /** 自动化选项：存 localStorage（前端定时器读它，无需后端往返） */
  const updateAutoSync = (patch: Partial<AutoSyncConfig>) => {
    const next = { ...autoSync, ...patch };
    setAutoSync(next);
    saveAutoSyncConfig(next);
  };

  /** 用冲突副本替换本机库：成功后必须重载（本机库已被换掉） */
  const restoreConflict = async (name: string) => {
    try {
      await flushAllForClose();
      await invoke("restore_sync_conflict", { name });
      window.location.reload();
    } catch (e) {
      logger.error("restore conflict failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const openConflictsDir = async () => {
    try {
      await invoke("open_conflicts_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  // ————— AI 助手：读取/保存配置 —————
  const applyAiConfig = (c: AiConfig) => {
    setAiConfig(c);
    setAiForm({
      enabled: c.enabled,
      provider: AI_PROVIDER_PRESETS.some((p) => p.id === c.provider) ? c.provider : "custom",
      baseUrl: c.base_url,
      model: c.model,
      maxChars: c.max_chars,
    });
  };

  /** 保存（可选局部更新）；apiKey 留空表示不修改（传 null），保存后清空输入框 */
  const persistAi = async (partial?: Partial<AiFormState>, apiKey = aiApiKey): Promise<void> => {
    const next = { ...aiForm, ...partial };
    setAiForm(next);
    await aiSaveConfig({
      enabled: next.enabled,
      provider: next.provider,
      baseUrl: next.baseUrl,
      model: next.model,
      maxChars: next.maxChars,
      apiKey: apiKey.trim() === "" ? null : apiKey,
    });
    const c = await aiGetConfig();
    applyAiConfig(c);
    useAiStore.getState().setConfig(c);
    setAiApiKey("");
  };

  const saveAi = (partial?: Partial<AiFormState>) => {
    persistAi(partial).then(
      () => toast.success(t("settings.aiSaved")),
      (e: unknown) => toast.error(t("settings.aiSaveFailed", { message: String(e) })),
    );
  };

  const saveAiQuietly = (partial?: Partial<AiFormState>) => {
    persistAi(partial).catch((e: unknown) => toast.error(t("settings.aiSaveFailed", { message: String(e) })));
  };

  /** 测试连接：先保存当前配置（Rust 侧读持久化配置）再测试 */
  const testAi = async () => {
    setBusyAiTest(true);
    try {
      await persistAi();
      const msg = await aiTestConnection();
      toast.success(t("settings.aiTestOk", { message: msg }));
    } catch (e) {
      logger.error("ai test connection failed", e);
      toast.error(t("settings.aiTestFailed", { message: String(e) }));
    } finally {
      setBusyAiTest(false);
    }
  };

  /** 选/换同步文件夹（传空串 = 关闭同步） */
  const chooseSyncDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      setSyncInfo(await invoke<SyncInfo>("set_sync_dir", { dir: picked }));
    } catch (e) {
      logger.error("set sync dir failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const turnSyncOff = async () => {
    try {
      setSyncInfo(await invoke<SyncInfo>("set_sync_dir", { dir: "" }));
    } catch (e) {
      logger.error("disable sync failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const openSyncDir = async () => {
    try {
      await invoke<void>("open_sync_dir");
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  /**
   * 手动双向同步。拉取（本机库被远端替换）后前端的树/表格/文档全是旧数据，
   * 必须重新加载——直接重载窗口最彻底，避免残留缓存的旧文档回写覆盖远端数据。
   */
  const syncNow = async () => {
    setBusySync(true);
    try {
      // 同步会短暂关库（拉取时还要替换本机库）：先把编辑器自动保存、视图配置等挂起写入
      // 全部冲刷落盘，避免它们撞进维护窗口失败，或落在随即被替换的旧库上
      await flushAllForClose();
      const r = await invoke<SyncRunResult>("run_sync");
      setSyncInfo(r.info);
      // 本次可能新产生/清理了冲突副本，重新拉取列表
      invoke<ConflictFile[]>("list_sync_conflicts")
        .then(setConflictFiles)
        .catch((e: unknown) => logger.error("failed to list sync conflicts", e));
      const key = SYNC_ACTION_KEY[r.action] ?? "settings.syncActionNone";
      const extra = r.assets_copied > 0 ? ` · ${t("settings.syncAssets", { n: r.assets_copied })}` : "";
      if (r.action === "conflict") {
        toast.warning(t(key) + extra, {
          description:
            r.conflicts.length > 0 ? `${t("settings.syncConflictFiles")}: ${r.conflicts.join(", ")}` : undefined,
        });
      } else {
        toast.success(t(key) + extra);
      }
      if (r.pulled) {
        // 本机库刚被替换：立即重载，不能再等（原 1.5s 延迟窗口里编辑器会自动把旧内存态
        // 写回新库、覆盖刚拉取的内容）；重载后树/文档/设置页全部读新库
        window.location.reload();
        return;
      }
      // 未被替换：同步期间撞进维护窗口而失败的保存，这里重试一次
      await flushAllForClose();
    } catch (e) {
      logger.error("run sync failed", e);
      toast.error(`${t("settings.syncFailed")}：${String(e)}`);
    } finally {
      setBusySync(false);
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
            <p className="text-xs text-neutral-500">{version ? `TsFlowy · v${version}` : "TsFlowy"}</p>
          </div>
        </header>

        <Section title={t("settings.updates")}>
          <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.updateDesc")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={checkForUpdates}
              disabled={updateState === "checking" || updateState === "downloading" || updateState === "installing"}
            >
              <RefreshCw className={cn("mr-1 h-3.5 w-3.5", updateState === "checking" && "animate-spin")} />
              {updateState === "checking" ? t("settings.updateChecking") : t("settings.checkUpdate")}
            </Button>
            {updateState === "available" && (
              <Button size="sm" onClick={installUpdate}>
                <DownloadCloud className="mr-1 h-3.5 w-3.5" />
                {t("settings.updateInstall")}
              </Button>
            )}
            <span className="text-xs text-neutral-500">
              {updateState === "available" && updateVersion
                ? t("settings.updateAvailable", { version: updateVersion })
                : null}
              {updateState === "downloading" ? t("settings.updateDownloading") : null}
              {updateState === "installing" ? t("settings.updateInstalling") : null}
            </span>
          </div>
        </Section>

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
          {dataDirInfo && (
            <div className="mt-1.5 text-[11px] text-neutral-500">
              {dataDirInfo.is_linked
                ? t("settings.dataDirLinked", { path: dataDirInfo.link_path })
                : t("settings.dataDirPlain")}
            </div>
          )}
          <RiskNotice risk={dataDirRisk} />
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

          <div className="mt-4 border-t border-neutral-200 pt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
              <input
                type="checkbox"
                checked={autoBackup?.enabled ?? false}
                disabled={!autoBackup}
                onChange={(e) => autoBackup && persistAutoBackup({ ...autoBackup, enabled: e.target.checked })}
              />
              {t("settings.autoBackupEnable")}
            </label>
            <p className="mb-3 mt-1.5 max-w-lg text-[11px] text-neutral-500">{t("settings.autoBackupDesc")}</p>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                {t("settings.autoBackupInterval")}
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                  value={autoBackup?.interval_hours ?? 24}
                  disabled={!autoBackup}
                  onChange={(e) =>
                    autoBackup && setAutoBackup({ ...autoBackup, interval_hours: Number(e.target.value) })
                  }
                  onBlur={() => autoBackup && persistAutoBackup(autoBackup)}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                {t("settings.autoBackupKeep")}
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                  value={autoBackup?.keep ?? 7}
                  disabled={!autoBackup}
                  onChange={(e) => autoBackup && setAutoBackup({ ...autoBackup, keep: Number(e.target.value) })}
                  onBlur={() => autoBackup && persistAutoBackup(autoBackup)}
                />
              </label>
              <Button size="sm" variant="outline" onClick={backupNow} disabled={busyBackupNow || !autoBackup}>
                {busyBackupNow ? (
                  <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.autoBackupNow")}
              </Button>
            </div>
            {autoBackup && (
              <div className="mt-3 text-[11px] text-neutral-500">
                {t("settings.autoBackupLast")}：{autoBackup.last_backup ?? t("settings.autoBackupNever")}
                <span className="ml-2 break-all font-mono">{autoBackup.dir}</span>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("settings.assets")}>
          <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.assetsDesc")}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={scanAssets} disabled={busyAssets}>
              {busyAssets ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <HardDrive className="mr-1 h-3.5 w-3.5" />
              )}
              {busyAssets ? t("settings.assetsScanning") : t("settings.assetsScan")}
            </Button>
            {orphanScan && orphanScan.total_files > 0 && (
              <Button size="sm" variant="outline" onClick={() => setPurgeAssetsOpen(true)} disabled={busyAssets}>
                {t("settings.assetsPurge")}
              </Button>
            )}
          </div>
          {orphanScan && (
            <div className="mt-3 text-[11px] text-neutral-500">
              {orphanScan.total_files === 0
                ? t("settings.assetsNone")
                : t("settings.assetsFound", {
                    n: String(orphanScan.total_files),
                    size: formatBytes(orphanScan.total_bytes),
                  })}
            </div>
          )}
        </Section>

        {/* 清理是「移动到备份目录」而非删除，故不做成危险操作样式 */}
        <ConfirmDialog
          open={purgeAssetsOpen}
          onOpenChange={setPurgeAssetsOpen}
          danger={false}
          title={t("settings.assets")}
          description={t("settings.assetsPurgeConfirm", { n: String(orphanScan?.total_files ?? 0) })}
          confirmLabel={t("settings.assetsPurge")}
          onConfirm={purgeAssets}
        />

        <Section title={t("settings.sync")}>
          <p className="mb-3 max-w-lg text-xs text-neutral-500">{t("settings.syncDesc")}</p>
          {syncInfo?.dir ? (
            <>
              <div className="mb-1 text-[11px] text-neutral-500">{t("settings.syncDirLabel")}</div>
              <div className="flex items-stretch gap-2">
                <input
                  readOnly
                  value={syncInfo.sync_path ?? syncInfo.dir}
                  className="flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 font-mono text-[11px] text-neutral-700 outline-none"
                />
                <Button size="sm" variant="outline" onClick={openSyncDir}>
                  <FolderOpen className="mr-1 h-3.5 w-3.5" />
                  {t("settings.syncOpen")}
                </Button>
              </div>
              {dataDirRisk === "sync-overlap" && <RiskNotice risk={dataDirRisk} />}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={syncNow} disabled={busySync}>
                  <RefreshCw className={cn("mr-1 h-3.5 w-3.5", busySync && "animate-spin")} />
                  {busySync ? "…" : t("settings.syncNow")}
                </Button>
                <Button size="sm" variant="outline" onClick={chooseSyncDir} disabled={busySync}>
                  <FolderInput className="mr-1 h-3.5 w-3.5" />
                  {t("settings.syncChange")}
                </Button>
                <Button size="sm" variant="outline" onClick={turnSyncOff} disabled={busySync}>
                  {t("settings.syncOff")}
                </Button>
              </div>
              <div className="mt-3 text-[11px] text-neutral-500">
                {t("settings.syncLast")}：{syncInfo.last_time ?? t("settings.syncNever")}
                {syncLastActionKey && <span className="ml-2">{t(syncLastActionKey)}</span>}
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                  <input
                    type="checkbox"
                    checked={autoSync.pullOnStart}
                    onChange={(e) => updateAutoSync({ pullOnStart: e.target.checked })}
                  />
                  {t("settings.syncAutoPull")}
                </label>
                <label className="flex items-center gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                  <input
                    type="checkbox"
                    checked={autoSync.syncAfterWrite}
                    onChange={(e) => updateAutoSync({ syncAfterWrite: e.target.checked })}
                  />
                  {t("settings.syncAutoWrite")}
                  {autoSync.syncAfterWrite && (
                    <span className="ml-1 flex items-center gap-1 text-[11px] text-neutral-500">
                      {t("settings.syncAutoDelay")}
                      <input
                        type="number"
                        min={5}
                        max={3600}
                        defaultValue={autoSync.delaySecs}
                        key={autoSync.delaySecs}
                        onBlur={(e) => updateAutoSync({ delaySecs: Number(e.target.value) })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        className="h-6 w-16 rounded-md border border-neutral-300 bg-white px-1.5 text-[11px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                      />
                      {t("settings.syncAutoDelayUnit")}
                    </span>
                  )}
                </label>
                <p className="max-w-lg text-[11px] text-neutral-400">{t("settings.syncAutoHint")}</p>
              </div>
              {conflictFiles.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                      {t("settings.syncConflictsTitle")}（{conflictFiles.length}）
                    </span>
                    <button className="text-[11px] text-brand-600 hover:underline" onClick={openConflictsDir}>
                      {t("settings.syncConflictsOpen")}
                    </button>
                  </div>
                  <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
                    {conflictFiles.map((f) => (
                      <li key={f.name} className="flex items-center gap-2 px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
                            {f.name}
                          </div>
                          <div className="text-[10px] text-neutral-400">
                            {f.modified} · {formatBytes(f.size)}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setRestoreTarget(f)}>
                          {t("settings.syncConflictRestore")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[11px] text-neutral-500">{t("settings.syncOffHint")}</span>
              <Button size="sm" variant="outline" onClick={chooseSyncDir}>
                <FolderInput className="mr-1 h-3.5 w-3.5" />
                {t("settings.syncChoose")}
              </Button>
            </div>
          )}
        </Section>

        <ConfirmDialog
          open={restoreTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRestoreTarget(null);
          }}
          danger
          title={t("settings.syncConflictRestore")}
          description={t("settings.syncConflictRestoreConfirm", { name: restoreTarget?.name ?? "" })}
          confirmLabel={t("settings.syncConflictRestore")}
          onConfirm={() => {
            const name = restoreTarget?.name;
            setRestoreTarget(null);
            if (name) void restoreConflict(name);
          }}
        />

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

        <Section title={t("settings.ai")}>
          <p className="max-w-lg text-xs text-neutral-500">{t("settings.aiDesc")}</p>
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
            <input type="checkbox" checked={aiForm.enabled} onChange={(e) => saveAi({ enabled: e.target.checked })} />
            {t("settings.aiEnable")}
          </label>
          <Row label={t("settings.aiProvider")}>
            <select
              value={aiForm.provider}
              onChange={(e) => {
                const preset = AI_PROVIDER_PRESETS.find((p) => p.id === e.target.value);
                if (preset) saveAi({ provider: preset.id, baseUrl: preset.baseUrl, model: preset.model });
              }}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
            >
              {AI_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(AI_PROVIDER_LABEL_KEY[p.id])}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("settings.aiBaseUrl")}>
            <input
              value={aiForm.baseUrl}
              onChange={(e) => setAiForm((f) => ({ ...f, baseUrl: e.target.value }))}
              onBlur={() => saveAiQuietly()}
              placeholder={t("settings.aiBaseUrlPlaceholder")}
              className="h-7 w-80 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            />
          </Row>
          <Row label={t("settings.aiModel")}>
            <input
              value={aiForm.model}
              onChange={(e) => setAiForm((f) => ({ ...f, model: e.target.value }))}
              onBlur={() => saveAiQuietly()}
              placeholder={t("settings.aiModelPlaceholder")}
              className="h-7 w-80 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            />
          </Row>
          <Row label={t("settings.aiApiKey")}>
            <input
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              onBlur={() => saveAiQuietly()}
              autoComplete="off"
              placeholder={
                aiConfig?.has_api_key ? t("settings.aiApiKeyPlaceholderSaved") : t("settings.aiApiKeyPlaceholderEmpty")
              }
              className="h-7 w-80 rounded-md border border-neutral-300 bg-white px-2 font-mono text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            />
          </Row>
          {aiConfig?.has_api_key && aiConfig.api_key_masked && (
            <p className="-mt-2 text-right text-[11px] text-neutral-400">
              {`${t("settings.aiApiKeySaved")}：${aiConfig.api_key_masked}`}
            </p>
          )}
          <Row label={t("settings.aiMaxChars")}>
            <input
              type="number"
              min={500}
              max={200000}
              value={aiForm.maxChars}
              onChange={(e) => setAiForm((f) => ({ ...f, maxChars: Number(e.target.value) }))}
              onBlur={() => saveAiQuietly()}
              className="h-7 w-28 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
            />
          </Row>
          <Row label="">
            <Button size="sm" variant="outline" onClick={testAi} disabled={busyAiTest}>
              {busyAiTest ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3.5 w-3.5" />
              )}
              {busyAiTest ? t("settings.aiTesting") : t("settings.aiTest")}
            </Button>
          </Row>
          <p className="text-[11px] text-amber-600">{t("settings.aiPrivacy")}</p>
        </Section>

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
      </div>
    </div>
  );
}
