// 设置页的独立辅助部件：类型、常量与无外部状态依赖的展示组件。
// 从 SettingsPage.tsx 原样搬出（无逻辑/样式改动），SettingsPage 只负责状态与编排。
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { getPresetPreview, type ThemeMode, type ThemePresetId, type AccentColor } from "@/stores/settings";
import {
  useShortcutsStore,
  CUSTOMIZABLE_SHORTCUTS,
  eventToCombo,
  formatCombo,
  findConflict,
  isBindableCombo,
  type ShortcutId,
} from "@/lib/shortcuts";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DataDirRisk } from "@/lib/data-dir-risk";

export const ACCENT_HEX: Record<AccentColor, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  orange: "#ea580c",
  purple: "#9333ea",
  red: "#dc2626",
  yellow: "#ca8a04",
  slate: "#334155",
  rose: "#e11d48",
};

export interface ShortcutItem {
  label: string;
  /** 可自定义的全局快捷键 id；缺省表示只读展示 */
  id?: ShortcutId;
  /** 只读展示时的组合文案 */
  key?: string;
}

export interface ShortcutGroup {
  titleKey: string;
  /** 是否允许自定义（仅全局组） */
  customizable?: boolean;
  items: ShortcutItem[];
}

/** get_data_dir_info 返回结构（Rust 侧字段名即 JSON 键名） */
export interface DataDirInfo {
  default: string;
  custom: string | null;
  will_change_after_restart: boolean;
  /** 默认目录是否为指向别处的目录联接（junction/symlink） */
  is_linked: boolean;
  /** 目录联接所在路径（系统默认数据目录） */
  link_path: string;
}

/** change_data_dir / reset_data_dir_default 返回结构 */
export interface ChangeDataDirResult {
  need_restart: boolean;
  copied: boolean;
}

/** get_auto_backup_config / set_auto_backup_config 返回结构 */
export interface AutoBackupInfo {
  enabled: boolean;
  interval_hours: number;
  keep: number;
  /** backups/ 目录绝对路径 */
  dir: string;
  /** 最近一次自动备份时间（本地时间字符串），从未备份为 null */
  last_backup: string | null;
}

/** get_sync_info / set_sync_dir 返回结构 */
export interface SyncInfo {
  /** 用户选择的同步文件夹；null = 未开启 */
  dir: string | null;
  /** 实际存放数据的目录（<dir>/TsFlowySync） */
  sync_path: string | null;
  /** 上次同步动作：none / upload / download / conflict */
  last_action: string | null;
  last_time: string | null;
}

/** list_sync_conflicts 返回结构 */
export interface ConflictFile {
  name: string;
  size: number;
  /** 修改时间（本地时间串） */
  modified: string;
}

/** run_sync 返回结构 */
export interface SyncRunResult {
  action: string;
  /** 本机库是否被替换：true 时必须重新加载前端数据 */
  pulled: boolean;
  assets_copied: number;
  conflicts: string[];
  info: SyncInfo;
}

/** 同步动作 → i18n 文案 */
export const SYNC_ACTION_KEY: Record<string, MessageKey> = {
  none: "settings.syncActionNone",
  upload: "settings.syncActionUpload",
  download: "settings.syncActionDownload",
  conflict: "settings.syncActionConflict",
};

/** AI 助手表单（与 AiConfig 的 snake_case 字段解耦，便于本地编辑） */
export interface AiFormState {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  maxChars: number;
  /** AI 自主修改文档前先弹 diff 确认 */
  confirmEdit: boolean;
}

/** AI 服务商预设 → i18n 文案 */
export const AI_PROVIDER_LABEL_KEY: Record<string, MessageKey> = {
  custom: "settings.aiProviderCustom",
  deepseek: "settings.aiProviderDeepseek",
  qwen: "settings.aiProviderQwen",
  kimi: "settings.aiProviderKimi",
  ollama: "settings.aiProviderOllama",
};

/**
 * 更新器报错转成人话：DNS 解析失败、连接超时/被重置、TLS 握手失败都会抛 reqwest 的
 * "error sending request for url (...)"，对用户毫无意义，统一收敛成一句网络提示；
 * 其余错误（签名校验失败、latest.json 异常等）保留原文，便于定位。
 */
export function updateErrorMessage(e: unknown): string {
  const raw = String(e);
  const isTransportError =
    /error sending request|error trying to connect|timed out|dns error|connection (refused|reset)|unexpected eof|tls|invalid peer certificate/i.test(
      raw,
    );
  return isTransportError ? t("settings.updateNetworkError") : t("settings.updateFailed", { message: raw });
}

/** 字节数 → 可读体积（资源清理的体积展示） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 数据目录风险提示（云同步盘 / 与同步目录嵌套）；无风险时不渲染 */
export function RiskNotice({ risk }: { risk: DataDirRisk | null }) {
  if (!risk) return null;
  return (
    <div className="mt-2 max-w-lg rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
      {t(risk === "cloud" ? "settings.dataDirRiskCloud" : "settings.dataDirRiskOverlap")}
    </div>
  );
}

/** 可自定义快捷键的录制按钮：点按后捕获下一个组合键 */
export function ShortcutRecorder({ id }: { id: ShortcutId }) {
  const combo = useShortcutsStore((s) => s.combos[id]);
  const customized = useShortcutsStore((s) => s.overrides[id] !== undefined);
  const setShortcut = useShortcutsStore((s) => s.setShortcut);
  const resetShortcut = useShortcutsStore((s) => s.resetShortcut);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // 捕获阶段拦截，避免这次按键触发 App 的全局快捷键
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const next = eventToCombo(e);
      if (!next) return; // 纯修饰键，继续等待
      if (!isBindableCombo(next)) {
        toast.error(t("settings.shortcutNeedModifier"));
        return;
      }
      const conflict = findConflict(id, next);
      if (conflict) {
        const def = CUSTOMIZABLE_SHORTCUTS.find((s) => s.id === conflict);
        toast.error(t("settings.shortcutConflict", { name: def ? t(def.labelKey as MessageKey) : conflict }));
        return;
      }
      setShortcut(id, next);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, id, setShortcut]);

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setRecording((v) => !v)}
        className={cn(
          "rounded border px-1.5 py-0.5 font-mono text-[10px] shadow-sm transition-colors",
          recording
            ? "border-brand-500 bg-brand-50 text-brand-600"
            : "border-neutral-300 bg-neutral-100 text-neutral-600 hover:bg-neutral-200",
        )}
      >
        {recording ? t("settings.shortcutRecording") : formatCombo(combo)}
      </button>
      {customized ? (
        <button
          type="button"
          onClick={() => resetShortcut(id)}
          className="text-[10px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
        >
          {t("settings.shortcutReset")}
        </button>
      ) : null}
    </span>
  );
}

/** 全局组标题右侧的「全部恢复默认」，仅在有自定义项时出现 */
export function ResetAllShortcuts() {
  const hasOverride = useShortcutsStore((s) => Object.keys(s.overrides).length > 0);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  if (!hasOverride) return null;
  return (
    <button
      type="button"
      onClick={resetAll}
      className="text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
    >
      {t("settings.shortcutResetAll")}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-neutral-800">{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function ThemeGroup({ value, onChange }: { value: ThemeMode; onChange: (v: ThemeMode) => void }) {
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

export const THEME_PRESET_LABEL_KEY: Record<ThemePresetId, MessageKey> = {
  appflowy: "settings.themePresetAppflowy",
  graphite: "settings.themePresetGraphite",
  forest: "settings.themePresetForest",
  violet: "settings.themePresetViolet",
  sunset: "settings.themePresetSunset",
  rose: "settings.themePresetRose",
};

/** 预览卡跟随当前生效的浅色/深色模式（system 取渲染时 matchMedia 结果） */
export function isPreviewDark(theme: ThemeMode): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** 主题预设预览卡：迷你"侧边栏 + 内容区"示意图，所见即所选 */
export function ThemePresetCard({
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

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
