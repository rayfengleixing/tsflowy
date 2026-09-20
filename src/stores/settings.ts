import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type AccentColor = "blue" | "green" | "orange" | "purple" | "red" | "yellow" | "slate" | "rose";
export type FontFamily = "sans" | "serif" | "mono";
/** 编辑器正文字号档位：sm 14 / md 16（默认）/ lg 18 / xl 20 */
export type FontSize = "sm" | "md" | "lg" | "xl";

export const FONT_SIZE_PX: Record<FontSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};
export const FONT_SIZE_PRESETS: FontSize[] = ["sm", "md", "lg", "xl"];

const FONT_SIZE_KEY = "tsflowy-font-size";

function loadFontSize(): FontSize {
  try {
    const v = localStorage.getItem(FONT_SIZE_KEY);
    return v === "sm" || v === "md" || v === "lg" || v === "xl" ? v : "md";
  } catch {
    return "md";
  }
}

/** 编辑器正文行距档位：紧凑 1.5 / 正常 1.75（默认，与原硬编码一致）/ 宽松 2.0 */
export type LineHeight = "compact" | "normal" | "loose";

export const LINE_HEIGHT_VALUE: Record<LineHeight, number> = {
  compact: 1.5,
  normal: 1.75,
  loose: 2.0,
};
export const LINE_HEIGHT_PRESETS: LineHeight[] = ["compact", "normal", "loose"];

const LINE_HEIGHT_KEY = "tsflowy-line-height";

function loadLineHeight(): LineHeight {
  try {
    const v = localStorage.getItem(LINE_HEIGHT_KEY);
    return v === "compact" || v === "normal" || v === "loose" ? v : "normal";
  } catch {
    return "normal";
  }
}

/** 编辑区内容宽度档位：窄 640 / 默认 800 / 宽 960 / 超宽 1120（px） */
export type EditorWidth = "narrow" | "default" | "wide" | "xwide";

export const EDITOR_WIDTH_PX: Record<EditorWidth, number> = {
  narrow: 640,
  default: 800,
  wide: 960,
  xwide: 1120,
};
export const EDITOR_WIDTH_PRESETS: EditorWidth[] = ["narrow", "default", "wide", "xwide"];

const EDITOR_WIDTH_KEY = "tsflowy-editor-width";

function loadEditorWidth(): EditorWidth {
  try {
    const v = localStorage.getItem(EDITOR_WIDTH_KEY);
    return v === "narrow" || v === "default" || v === "wide" || v === "xwide" ? v : "default";
  } catch {
    return "default";
  }
}

interface SettingsState {
  lang: "zh-CN" | "en-US";
  theme: ThemeMode;
  themePreset: ThemePresetId;
  accent: AccentColor;
  font: FontFamily;
  fontSize: FontSize;
  lineHeight: LineHeight;
  editorWidth: EditorWidth;

  setLang: (lang: "zh-CN" | "en-US") => void;
  setTheme: (t: ThemeMode) => void;
  setThemePreset: (p: ThemePresetId) => void;
  setAccent: (a: AccentColor) => void;
  setFont: (f: FontFamily) => void;
  setFontSize: (s: FontSize) => void;
  setLineHeight: (l: LineHeight) => void;
  setEditorWidth: (w: EditorWidth) => void;
}

const ACCENT_CLASS_BY_COLOR: Record<AccentColor, { brand: string; palette: Record<50 | 100 | 500 | 600, string> }> = {
  blue: { brand: "blue", palette: { 50: "#EFF6FF", 100: "#DBEAFE", 500: "#2563EB", 600: "#1D4ED8" } },
  green: { brand: "green", palette: { 50: "#F0FDF4", 100: "#DCFCE7", 500: "#16A34A", 600: "#15803D" } },
  orange: { brand: "orange", palette: { 50: "#FFF7ED", 100: "#FFEDD5", 500: "#EA580C", 600: "#C2410C" } },
  purple: { brand: "purple", palette: { 50: "#FAF5FF", 100: "#F3E8FF", 500: "#9333EA", 600: "#7E22CE" } },
  red: { brand: "red", palette: { 50: "#FEF2F2", 100: "#FEE2E2", 500: "#DC2626", 600: "#B91C1C" } },
  yellow: { brand: "yellow", palette: { 50: "#FEFCE8", 100: "#FEF9C3", 500: "#CA8A04", 600: "#A16207" } },
  slate: { brand: "slate", palette: { 50: "#F8FAFC", 100: "#F1F5F9", 500: "#334155", 600: "#1E293B" } },
  rose: { brand: "rose", palette: { 50: "#FFF1F2", 100: "#FFE4E6", 500: "#E11D48", 600: "#BE123C" } },
};

export const ACCENT_PRESETS: AccentColor[] = ["blue", "green", "orange", "purple", "red", "yellow", "slate", "rose"];

/** 把当前强调色写入 Tailwind v4 `--color-brand-*` 语义化色阶（内联 style 优先于 @theme 定义，立即可用类名 bg-brand-* / text-brand-* 生效） */
export function applyAccentToDocument(accent: AccentColor) {
  const { palette } = ACCENT_CLASS_BY_COLOR[accent];
  const root = document.documentElement;
  root.style.setProperty("--color-brand-50", palette[50]);
  root.style.setProperty("--color-brand-100", palette[100]);
  root.style.setProperty("--color-brand-500", palette[500]);
  root.style.setProperty("--color-brand-600", palette[600]);
  // 主按钮（Button 默认变体 bg-primary）跟随强调色，浅/深色模式一致
  root.style.setProperty("--primary", palette[500]);
  root.style.setProperty("--primary-foreground", "#ffffff");
  // 与 @theme 中 --ring 同步，focus ring 颜色跟强调色走
  root.style.setProperty("--ring", palette[500]);
  // 原生表单（checkbox/radio）强调色
  root.style.accentColor = palette[500];
}

export function getAccentClass(accent: AccentColor): string {
  return ACCENT_CLASS_BY_COLOR[accent].brand;
}

/** 应用主题：light/dark class 写到 <html>；system 则用 matchMedia 跟随 + 监听 */
export function applyThemeToDocument(mode: ThemeMode): () => void {
  const root = document.documentElement;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const dark = mode === "dark" || (mode === "system" && mql.matches);
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  };
  apply();
  if (mode === "system") {
    const onChange = () => apply();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  return () => {};
}

/* ————— 主题预设（整套配色，浅色/深色各一套变量；appflowy = 基础样式表默认） ————— */

export type ThemePresetId = "appflowy" | "graphite" | "forest" | "violet" | "sunset" | "rose";

export interface ThemePreset {
  /** 主题自带品牌强调色：选主题时同步到 accent（手动选强调色可覆盖品牌色） */
  accent: AccentColor;
  /** 浅色变量（undefined = 不覆盖基础样式表） */
  light?: Record<string, string>;
  /** 深色变量 */
  dark?: Record<string, string>;
}

export const THEME_PRESET_IDS: ThemePresetId[] = ["appflowy", "graphite", "forest", "violet", "sunset", "rose"];

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  appflowy: { accent: "blue" },
  graphite: {
    accent: "slate",
    light: {
      "--background": "#FFFFFF",
      "--foreground": "#37352F",
      "--card": "#FFFFFF",
      "--card-foreground": "#37352F",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#37352F",
      "--secondary": "#F1F1EF",
      "--secondary-foreground": "#37352F",
      "--muted": "#F1F1EF",
      "--muted-foreground": "#787774",
      "--accent": "#EDEDEC",
      "--accent-foreground": "#37352F",
      "--border": "#E9E9E7",
      "--input": "#E9E9E7",
      "--sidebar": "#F7F7F5",
      "--sidebar-foreground": "#37352F",
      "--sidebar-accent": "#EDEDEC",
      "--sidebar-accent-foreground": "#37352F",
      "--sidebar-border": "#E9E9E7",
      "--color-neutral-50": "#FBFBFA",
      "--color-neutral-100": "#FBFBFA",
      "--color-neutral-200": "#EDEDEC",
      "--color-neutral-300": "#E3E3E1",
      "--color-neutral-400": "#C8C8C4",
      "--color-neutral-500": "#9B9B97",
      "--color-neutral-600": "#6F6F6B",
      "--color-neutral-700": "#D6D6D4",
      "--color-neutral-800": "#3D3D3A",
      "--color-neutral-850": "#323230",
      "--color-neutral-900": "#262625",
      "--color-neutral-1000": "#202020",
    },
    dark: {
      "--background": "#191919",
      "--foreground": "#E6E6E4",
      "--card": "#202020",
      "--card-foreground": "#E6E6E4",
      "--popover": "#202020",
      "--popover-foreground": "#E6E6E4",
      "--secondary": "#2A2A29",
      "--secondary-foreground": "#E6E6E4",
      "--muted": "#2A2A29",
      "--muted-foreground": "#9B9B97",
      "--accent": "#2F2F2E",
      "--accent-foreground": "#E6E6E4",
      "--border": "rgba(233,230,228,0.09)",
      "--input": "rgba(233,230,228,0.14)",
      "--sidebar": "#252525",
      "--sidebar-foreground": "#E6E6E4",
      "--sidebar-accent": "#2F2F2E",
      "--sidebar-accent-foreground": "#E6E6E4",
      "--sidebar-border": "rgba(233,230,228,0.09)",
      "--color-neutral-50": "#1E1E1D",
      "--color-neutral-100": "#1E1E1D",
      "--color-neutral-200": "#262625",
      "--color-neutral-300": "#2E2E2D",
      "--color-neutral-400": "#3D3D3B",
      "--color-neutral-500": "#555553",
      "--color-neutral-600": "#6E6E6C",
      "--color-neutral-700": "#3C3C3A",
      "--color-neutral-800": "#2C2C2B",
      "--color-neutral-850": "#232322",
      "--color-neutral-900": "#1E1E1D",
      "--color-neutral-1000": "#1A1A19",
    },
  },
  forest: {
    accent: "green",
    light: {
      "--background": "#F7F9F4",
      "--foreground": "#2E3A2E",
      "--card": "#FFFFFF",
      "--card-foreground": "#2E3A2E",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#2E3A2E",
      "--secondary": "#EDF2E9",
      "--secondary-foreground": "#2E3A2E",
      "--muted": "#EDF2E9",
      "--muted-foreground": "#6F7F70",
      "--accent": "#E4EDE0",
      "--accent-foreground": "#2E3A2E",
      "--border": "#DCE5D7",
      "--input": "#DCE5D7",
      "--sidebar": "#E8EFE4",
      "--sidebar-foreground": "#2E3A2E",
      "--sidebar-accent": "#D9E4D2",
      "--sidebar-accent-foreground": "#2E3A2E",
      "--sidebar-border": "#D4E0CD",
      "--color-neutral-50": "#F5F8F2",
      "--color-neutral-100": "#F5F8F2",
      "--color-neutral-200": "#E4EDE0",
      "--color-neutral-300": "#D2DECC",
      "--color-neutral-400": "#B7C8AF",
      "--color-neutral-500": "#93A78B",
      "--color-neutral-600": "#6B7D65",
      "--color-neutral-700": "#C6D5C0",
      "--color-neutral-800": "#35402F",
      "--color-neutral-850": "#2C3628",
      "--color-neutral-900": "#232B20",
      "--color-neutral-1000": "#1E251C",
    },
    dark: {
      "--background": "#141A14",
      "--foreground": "#D9E4D9",
      "--card": "#1A221B",
      "--card-foreground": "#D9E4D9",
      "--popover": "#1A221B",
      "--popover-foreground": "#D9E4D9",
      "--secondary": "#1E2820",
      "--secondary-foreground": "#D9E4D9",
      "--muted": "#1E2820",
      "--muted-foreground": "#92A693",
      "--accent": "#223026",
      "--accent-foreground": "#D9E4D9",
      "--border": "rgba(217,228,217,0.09)",
      "--input": "rgba(217,228,217,0.14)",
      "--sidebar": "#19211A",
      "--sidebar-foreground": "#D9E4D9",
      "--sidebar-accent": "#223026",
      "--sidebar-accent-foreground": "#D9E4D9",
      "--sidebar-border": "rgba(217,228,217,0.09)",
      "--color-neutral-50": "#1C241D",
      "--color-neutral-100": "#1C241D",
      "--color-neutral-200": "#242E25",
      "--color-neutral-300": "#2B372D",
      "--color-neutral-400": "#3A483C",
      "--color-neutral-500": "#556556",
      "--color-neutral-600": "#6E806F",
      "--color-neutral-700": "#37453A",
      "--color-neutral-800": "#27332A",
      "--color-neutral-850": "#202A22",
      "--color-neutral-900": "#1B241C",
      "--color-neutral-1000": "#171F18",
    },
  },
  violet: {
    accent: "purple",
    light: {
      "--background": "#FCFCFE",
      "--foreground": "#2F2B3E",
      "--card": "#FFFFFF",
      "--card-foreground": "#2F2B3E",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#2F2B3E",
      "--secondary": "#F5F2FB",
      "--secondary-foreground": "#2F2B3E",
      "--muted": "#F5F2FB",
      "--muted-foreground": "#6F6884",
      "--accent": "#EDE9F7",
      "--accent-foreground": "#2F2B3E",
      "--border": "#E1DAF0",
      "--input": "#E1DAF0",
      "--sidebar": "#EFEAFA",
      "--sidebar-foreground": "#2F2B3E",
      "--sidebar-accent": "#E3DBF6",
      "--sidebar-accent-foreground": "#2F2B3E",
      "--sidebar-border": "#E0D8F2",
      "--color-neutral-50": "#F9F7FC",
      "--color-neutral-100": "#F9F7FC",
      "--color-neutral-200": "#ECE7F6",
      "--color-neutral-300": "#DDD5EE",
      "--color-neutral-400": "#C1B4DF",
      "--color-neutral-500": "#9E8EC5",
      "--color-neutral-600": "#7669A0",
      "--color-neutral-700": "#D0C5E9",
      "--color-neutral-800": "#3B3550",
      "--color-neutral-850": "#302B42",
      "--color-neutral-900": "#272238",
      "--color-neutral-1000": "#221D31",
    },
    dark: {
      "--background": "#171522",
      "--foreground": "#E2DEF0",
      "--card": "#1F1C2E",
      "--card-foreground": "#E2DEF0",
      "--popover": "#1F1C2E",
      "--popover-foreground": "#E2DEF0",
      "--secondary": "#241F35",
      "--secondary-foreground": "#E2DEF0",
      "--muted": "#241F35",
      "--muted-foreground": "#9792B5",
      "--accent": "#2A2440",
      "--accent-foreground": "#E2DEF0",
      "--border": "rgba(226,222,240,0.10)",
      "--input": "rgba(226,222,240,0.15)",
      "--sidebar": "#1D1A2B",
      "--sidebar-foreground": "#E2DEF0",
      "--sidebar-accent": "#2C2742",
      "--sidebar-accent-foreground": "#E2DEF0",
      "--sidebar-border": "rgba(226,222,240,0.10)",
      "--color-neutral-50": "#201C2F",
      "--color-neutral-100": "#201C2F",
      "--color-neutral-200": "#282340",
      "--color-neutral-300": "#2F2A48",
      "--color-neutral-400": "#3E3860",
      "--color-neutral-500": "#5A5280",
      "--color-neutral-600": "#756D9C",
      "--color-neutral-700": "#383354",
      "--color-neutral-800": "#2A2540",
      "--color-neutral-850": "#221E35",
      "--color-neutral-900": "#1D192C",
      "--color-neutral-1000": "#191525",
    },
  },
  sunset: {
    accent: "orange",
    light: {
      "--background": "#FBF9F6",
      "--foreground": "#3B322A",
      "--card": "#FFFFFF",
      "--card-foreground": "#3B322A",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#3B322A",
      "--secondary": "#F6F0E7",
      "--secondary-foreground": "#3B322A",
      "--muted": "#F6F0E7",
      "--muted-foreground": "#8A7961",
      "--accent": "#F1E9DD",
      "--accent-foreground": "#3B322A",
      "--border": "#E9DCC9",
      "--input": "#E9DCC9",
      "--sidebar": "#F5EDE2",
      "--sidebar-foreground": "#3B322A",
      "--sidebar-accent": "#EFE3D2",
      "--sidebar-accent-foreground": "#3B322A",
      "--sidebar-border": "#E8DAC8",
      "--color-neutral-50": "#FAF5EE",
      "--color-neutral-100": "#FAF5EE",
      "--color-neutral-200": "#F1E7D9",
      "--color-neutral-300": "#E5D7C3",
      "--color-neutral-400": "#D0BC9F",
      "--color-neutral-500": "#AE9676",
      "--color-neutral-600": "#83694C",
      "--color-neutral-700": "#E0CFB6",
      "--color-neutral-800": "#453A2C",
      "--color-neutral-850": "#382E23",
      "--color-neutral-900": "#2D251C",
      "--color-neutral-1000": "#262017",
    },
    dark: {
      "--background": "#1B1713",
      "--foreground": "#EFE5D9",
      "--card": "#241F19",
      "--card-foreground": "#EFE5D9",
      "--popover": "#241F19",
      "--popover-foreground": "#EFE5D9",
      "--secondary": "#2A241D",
      "--secondary-foreground": "#EFE5D9",
      "--muted": "#2A241D",
      "--muted-foreground": "#AE9C86",
      "--accent": "#33291F",
      "--accent-foreground": "#EFE5D9",
      "--border": "rgba(239,229,217,0.09)",
      "--input": "rgba(239,229,217,0.14)",
      "--sidebar": "#221D17",
      "--sidebar-foreground": "#EFE5D9",
      "--sidebar-accent": "#33291F",
      "--sidebar-accent-foreground": "#EFE5D9",
      "--sidebar-border": "rgba(239,229,217,0.09)",
      "--color-neutral-50": "#241E18",
      "--color-neutral-100": "#241E18",
      "--color-neutral-200": "#2D261E",
      "--color-neutral-300": "#352D24",
      "--color-neutral-400": "#463C30",
      "--color-neutral-500": "#615545",
      "--color-neutral-600": "#7C6E59",
      "--color-neutral-700": "#40372C",
      "--color-neutral-800": "#2E2620",
      "--color-neutral-850": "#251F1A",
      "--color-neutral-900": "#201B15",
      "--color-neutral-1000": "#1B1712",
    },
  },
  rose: {
    accent: "rose",
    light: {
      "--background": "#FCFBFB",
      "--foreground": "#3B3134",
      "--card": "#FFFFFF",
      "--card-foreground": "#3B3134",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#3B3134",
      "--secondary": "#F8F1F3",
      "--secondary-foreground": "#3B3134",
      "--muted": "#F8F1F3",
      "--muted-foreground": "#8A767C",
      "--accent": "#F4E9EC",
      "--accent-foreground": "#3B3134",
      "--border": "#EFDFE3",
      "--input": "#EFDFE3",
      "--sidebar": "#F8EFF1",
      "--sidebar-foreground": "#3B3134",
      "--sidebar-accent": "#F1E3E7",
      "--sidebar-accent-foreground": "#3B3134",
      "--sidebar-border": "#EFDFE3",
      "--color-neutral-50": "#FBF6F7",
      "--color-neutral-100": "#FBF6F7",
      "--color-neutral-200": "#F2E6E9",
      "--color-neutral-300": "#E6D4DA",
      "--color-neutral-400": "#D3B2BB",
      "--color-neutral-500": "#B08A95",
      "--color-neutral-600": "#87656F",
      "--color-neutral-700": "#E3CED4",
      "--color-neutral-800": "#42333A",
      "--color-neutral-850": "#362A30",
      "--color-neutral-900": "#2C2227",
      "--color-neutral-1000": "#251D21",
    },
    dark: {
      "--background": "#191516",
      "--foreground": "#EEE2E5",
      "--card": "#221D1E",
      "--card-foreground": "#EEE2E5",
      "--popover": "#221D1E",
      "--popover-foreground": "#EEE2E5",
      "--secondary": "#272122",
      "--secondary-foreground": "#EEE2E5",
      "--muted": "#272122",
      "--muted-foreground": "#AC979D",
      "--accent": "#322529",
      "--accent-foreground": "#EEE2E5",
      "--border": "rgba(238,226,229,0.09)",
      "--input": "rgba(238,226,229,0.14)",
      "--sidebar": "#201B1C",
      "--sidebar-foreground": "#EEE2E5",
      "--sidebar-accent": "#322529",
      "--sidebar-accent-foreground": "#EEE2E5",
      "--sidebar-border": "rgba(238,226,229,0.09)",
      "--color-neutral-50": "#231D1F",
      "--color-neutral-100": "#231D1F",
      "--color-neutral-200": "#2B2426",
      "--color-neutral-300": "#322A2C",
      "--color-neutral-400": "#423739",
      "--color-neutral-500": "#5F5054",
      "--color-neutral-600": "#796669",
      "--color-neutral-700": "#3E3436",
      "--color-neutral-800": "#2D2628",
      "--color-neutral-850": "#241E20",
      "--color-neutral-900": "#1F1A1B",
      "--color-neutral-1000": "#1A1516",
    },
  },
};

const THEME_PRESET_KEY = "tsflowy-theme-preset";
const ACCENT_KEY = "tsflowy-accent";
const THEME_STYLE_ID = "tsflowy-theme-preset-style";

function loadThemePreset(): ThemePresetId {
  try {
    const v = localStorage.getItem(THEME_PRESET_KEY);
    return THEME_PRESET_IDS.includes(v as ThemePresetId) ? (v as ThemePresetId) : "appflowy";
  } catch {
    return "appflowy";
  }
}

function loadAccent(): AccentColor {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return ACCENT_PRESETS.includes(v as AccentColor) ? (v as AccentColor) : "blue";
  } catch {
    return "blue";
  }
}

const LANG_KEY = "tsflowy-lang";
const THEME_KEY = "tsflowy-theme";
const FONT_KEY = "tsflowy-font";

type Lang = "zh-CN" | "en-US";

function loadLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "zh-CN" || v === "en-US" ? v : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function loadFont(): FontFamily {
  try {
    const v = localStorage.getItem(FONT_KEY);
    return v === "sans" || v === "serif" || v === "mono" ? v : "sans";
  } catch {
    return "sans";
  }
}

/** 同步 <html lang>（无障碍 / 断行规则）；文案切换的重渲染由 App 订阅 lang 触发 */
export function applyLangToDocument(lang: Lang) {
  document.documentElement.lang = lang;
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

/**
 * 应用主题预设：运行时在 <head> 追加一个 style 元素，
 * 用 `:root{...}` / `.dark{...}` 覆盖基础样式表的同名变量（后出现者胜出）。
 * appflowy（默认）不覆盖 → 移除该元素，回落到 index.css 基础定义。
 * 品牌色（--color-brand-*）由 accent 机制以内联 style 覆盖，优先级高于本预设。
 */
export function applyThemePresetToDocument(preset: ThemePresetId) {
  const p = THEME_PRESETS[preset];
  const rules: string[] = [];
  if (p.light) rules.push(`:root{${toCssVars(p.light)}}`);
  if (p.dark) rules.push(`.dark{${toCssVars(p.dark)}}`);
  let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (rules.length === 0) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = THEME_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = rules.join("\n");
}

function toCssVars(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join("");
}

/** appflowy 预设无变量覆盖，预览卡取基础样式表近似色 */
const APPFLOWY_PREVIEW_FALLBACK = {
  light: { sidebar: "#e4e8f5", background: "#ffffff", foreground: "#3d404f", border: "#ced3e6" },
  dark: { sidebar: "#333333", background: "#1f1f1f", foreground: "#f5f5f5", border: "#3a3a3a" },
};

/** 主题预览卡用色：取预设变量（含品牌色 500），appflowy 用基础样式表近似色 */
export function getPresetPreview(id: ThemePresetId, dark: boolean) {
  const p = THEME_PRESETS[id];
  const fallback = APPFLOWY_PREVIEW_FALLBACK[dark ? "dark" : "light"];
  const vars = (dark ? p.dark : p.light) ?? {};
  const get = (k: string) => vars[k] as string | undefined;
  return {
    sidebar: get("--sidebar") ?? fallback.sidebar,
    background: get("--background") ?? fallback.background,
    foreground: get("--foreground") ?? fallback.foreground,
    border: get("--sidebar-border") ?? get("--border") ?? fallback.border,
    accent: ACCENT_CLASS_BY_COLOR[p.accent].palette[500],
  };
}

const FONT_CLASS: Record<FontFamily, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

export function applyFontToDocument(font: FontFamily) {
  const body = document.body;
  Object.values(FONT_CLASS).forEach((c) => body.classList.remove(c));
  body.classList.add(FONT_CLASS[font]);
}

/** 把正文字号写到 <html> 的 --tiptap-font-size CSS 变量，由 .tiptap 读取（默认 16px 兜底） */
export function applyFontSizeToDocument(size: FontSize) {
  document.documentElement.style.setProperty("--tiptap-font-size", `${FONT_SIZE_PX[size]}px`);
}

/** 把正文行距写到 <html> 的 --tiptap-line-height CSS 变量，由 .tiptap 读取（默认 1.75 兜底） */
export function applyLineHeightToDocument(lh: LineHeight) {
  document.documentElement.style.setProperty("--tiptap-line-height", `${LINE_HEIGHT_VALUE[lh]}`);
}

/** 把编辑区内容宽度写到 <html> 的 --tiptap-max-width CSS 变量，由编辑器内容容器读取（默认 800px 兜底） */
export function applyEditorWidthToDocument(w: EditorWidth) {
  document.documentElement.style.setProperty("--tiptap-max-width", `${EDITOR_WIDTH_PX[w]}px`);
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  lang: loadLang(),
  theme: loadTheme(),
  themePreset: loadThemePreset(),
  accent: loadAccent(),
  font: loadFont(),
  fontSize: loadFontSize(),
  lineHeight: loadLineHeight(),
  editorWidth: loadEditorWidth(),

  setLang: (lang) => {
    set({ lang });
    persist(LANG_KEY, lang);
    applyLangToDocument(lang);
  },
  setTheme: (theme) => {
    set({ theme });
    persist(THEME_KEY, theme);
    void applyThemeToDocument(theme);
  },
  setThemePreset: (themePreset) => {
    set({ themePreset });
    persist(THEME_PRESET_KEY, themePreset);
    applyThemePresetToDocument(themePreset);
    // 品牌色跟随主题自带强调色（手动选过的强调色被主题重置）
    const accent = THEME_PRESETS[themePreset].accent;
    set({ accent });
    persist(ACCENT_KEY, accent);
    applyAccentToDocument(accent);
  },
  setAccent: (accent) => {
    set({ accent });
    persist(ACCENT_KEY, accent);
    applyAccentToDocument(accent);
  },
  setFont: (font) => {
    set({ font });
    persist(FONT_KEY, font);
    applyFontToDocument(font);
  },
  setFontSize: (fontSize) => {
    set({ fontSize });
    try {
      localStorage.setItem(FONT_SIZE_KEY, fontSize);
    } catch {
      /* localStorage 不可用时静默降级 */
    }
    applyFontSizeToDocument(fontSize);
  },
  setLineHeight: (lineHeight) => {
    set({ lineHeight });
    try {
      localStorage.setItem(LINE_HEIGHT_KEY, lineHeight);
    } catch {
      /* localStorage 不可用时静默降级 */
    }
    applyLineHeightToDocument(lineHeight);
  },
  setEditorWidth: (editorWidth) => {
    set({ editorWidth });
    try {
      localStorage.setItem(EDITOR_WIDTH_KEY, editorWidth);
    } catch {
      /* localStorage 不可用时静默降级 */
    }
    applyEditorWidthToDocument(editorWidth);
  },
}));

/** App 启动时用 settings 存储当前值立即写一次（避免第一次进入才有效果） */
export function bootstrapVisualSettings() {
  const s = useSettingsStore.getState();
  applyLangToDocument(s.lang);
  applyThemePresetToDocument(s.themePreset);
  applyAccentToDocument(s.accent);
  applyFontToDocument(s.font);
  applyFontSizeToDocument(s.fontSize);
  applyLineHeightToDocument(s.lineHeight);
  applyEditorWidthToDocument(s.editorWidth);
  return applyThemeToDocument(s.theme);
}

export { FONT_CLASS };
