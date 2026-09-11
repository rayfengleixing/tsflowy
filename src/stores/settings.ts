import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type AccentColor = "blue" | "green" | "orange" | "purple" | "red" | "yellow";
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
  accent: AccentColor;
  font: FontFamily;
  fontSize: FontSize;
  lineHeight: LineHeight;
  editorWidth: EditorWidth;

  setLang: (lang: "zh-CN" | "en-US") => void;
  setTheme: (t: ThemeMode) => void;
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
};

export const ACCENT_PRESETS: AccentColor[] = ["blue", "green", "orange", "purple", "red", "yellow"];

/** 把当前强调色写入 Tailwind v4 `--color-brand-*` 语义化色阶（内联 style 优先于 @theme 定义，立即可用类名 bg-brand-* / text-brand-* 生效） */
export function applyAccentToDocument(accent: AccentColor) {
  const { palette } = ACCENT_CLASS_BY_COLOR[accent];
  const root = document.documentElement;
  root.style.setProperty("--color-brand-50", palette[50]);
  root.style.setProperty("--color-brand-100", palette[100]);
  root.style.setProperty("--color-brand-500", palette[500]);
  root.style.setProperty("--color-brand-600", palette[600]);
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
  lang: "zh-CN",
  theme: "light",
  accent: "blue",
  font: "sans",
  fontSize: loadFontSize(),
  lineHeight: loadLineHeight(),
  editorWidth: loadEditorWidth(),

  setLang: (lang) => set({ lang }),
  setTheme: (theme) => {
    set({ theme });
    void applyThemeToDocument(theme);
  },
  setAccent: (accent) => {
    set({ accent });
    applyAccentToDocument(accent);
  },
  setFont: (font) => {
    set({ font });
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
  applyAccentToDocument(s.accent);
  applyFontToDocument(s.font);
  applyFontSizeToDocument(s.fontSize);
  applyLineHeightToDocument(s.lineHeight);
  applyEditorWidthToDocument(s.editorWidth);
  return applyThemeToDocument(s.theme);
}

export { FONT_CLASS };
