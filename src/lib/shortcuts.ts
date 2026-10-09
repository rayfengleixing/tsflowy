// 可自定义的快捷键。全局命令（命令面板 / 快速打开 / 全局搜索 / 切换标签页 / 新建页面 /
// 打开设置 / 切换主题）由 App 的 window keydown 处理；编辑器内命令（加粗 / 斜体 / 下划线 /
// 删除线 / 撤销 / 重做）由 EditorPage 的 editorProps.handleKeyDown 处理——该回调先于
// TipTap 各扩展的内置 keymap 执行，命中即短路，因此改绑后旧默认键同样失效。
// 两组共用同一个 store 与冲突检测，跨组也互斥。
//
// 组合键统一用 Ctrl 表示（Windows/Linux 的 Ctrl 与 macOS 的 ⌘ 等价），
// 与既有快捷键表文案「Ctrl / ⌘」一致。

import { create } from "zustand";

export type ShortcutId =
  | "commandPalette"
  | "quickOpen"
  | "search"
  | "switchTab"
  | "newPage"
  | "openSettings"
  | "toggleTheme"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "undo"
  | "redo";

export interface Combo {
  /** Ctrl 或 ⌘（跨平台统一为一个开关） */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 规范化键名：字母/数字为小写，特殊键为 tab / space / enter 等 */
  key: string;
}

/** 默认绑定前的填充：默认带 Ctrl，可按需覆盖其它修饰键 */
function c(key: string, extra: Partial<Combo> = {}): Combo {
  return { ctrl: true, shift: false, alt: false, key, ...extra };
}

export const DEFAULT_SHORTCUTS: Record<ShortcutId, Combo> = {
  commandPalette: c("k"),
  quickOpen: c("p"),
  search: c("f", { shift: true }),
  switchTab: c("tab"),
  newPage: c("n"),
  openSettings: c(","),
  toggleTheme: c("d", { shift: true }),
  // 编辑器命令：与 TipTap 内置默认一致（strike 实为 Mod-Shift-s，非 Ctrl+Shift+X）
  bold: c("b"),
  italic: c("i"),
  underline: c("u"),
  strike: c("s", { shift: true }),
  undo: c("z"),
  redo: c("z", { shift: true }),
};

/** 全局组（顺序即设置页展示顺序） */
export const GLOBAL_SHORTCUT_IDS: ShortcutId[] = [
  "commandPalette",
  "quickOpen",
  "search",
  "switchTab",
  "newPage",
  "openSettings",
  "toggleTheme",
];

/** 编辑器组 */
export const EDITOR_SHORTCUT_IDS: ShortcutId[] = ["bold", "italic", "underline", "strike", "undo", "redo"];

/**
 * TipTap 各扩展内置的编辑器命令默认绑定。用户把对应命令改绑到其它组合后，
 * EditorPage 用这张表把旧默认键"吞掉"（handleKeyDown 先于扩展 keymap 执行），
 * 否则旧键仍会触发内置命令，造成"改绑了但旧键还能用"。
 */
export const BUILTIN_EDITOR_KEYS: { combo: Combo; id: ShortcutId }[] = [
  { combo: c("b"), id: "bold" },
  { combo: c("i"), id: "italic" },
  { combo: c("u"), id: "underline" },
  { combo: c("s", { shift: true }), id: "strike" },
  { combo: c("z"), id: "undo" },
  { combo: c("z", { shift: true }), id: "redo" },
  { combo: c("y"), id: "redo" },
];

/** 可自定义的快捷键（顺序即设置页展示顺序） */
export const CUSTOMIZABLE_SHORTCUTS: { id: ShortcutId; labelKey: string }[] = [
  { id: "commandPalette", labelKey: "settings.shortcuts.commandPalette" },
  { id: "quickOpen", labelKey: "settings.shortcuts.quickOpen" },
  { id: "search", labelKey: "settings.shortcuts.search" },
  { id: "switchTab", labelKey: "settings.shortcuts.switchTab" },
  { id: "newPage", labelKey: "settings.shortcuts.newPage" },
  { id: "openSettings", labelKey: "settings.shortcuts.openSettings" },
  { id: "toggleTheme", labelKey: "settings.shortcuts.toggleTheme" },
  { id: "bold", labelKey: "settings.shortcuts.bold" },
  { id: "italic", labelKey: "settings.shortcuts.italic" },
  { id: "underline", labelKey: "settings.shortcuts.underline" },
  { id: "strike", labelKey: "settings.shortcuts.strike" },
  { id: "undo", labelKey: "settings.shortcuts.undo" },
  { id: "redo", labelKey: "settings.shortcuts.redo" },
];

const STORAGE_KEY = "tsflowy-shortcuts";

/** 纯修饰键按下时不构成组合，录制时应忽略 */
export function normalizeKey(key: string): string | null {
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  if (key === " ") return "space";
  return key.toLowerCase();
}

/** 从键盘事件提取组合；纯修饰键返回 null */
export function eventToCombo(e: KeyboardEvent): Combo | null {
  const key = normalizeKey(e.key);
  if (!key) return null;
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, key };
}

export function comboEquals(a: Combo, b: Combo): boolean {
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** 是否为可用的自定义组合：必须带 Ctrl 或 Alt，避免劫持正常输入 */
export function isBindableCombo(combo: Combo): boolean {
  return (combo.ctrl || combo.alt) && combo.key !== "escape";
}

const KEY_LABEL: Record<string, string> = {
  tab: "Tab",
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** 展示用文案：Ctrl / ⌘ + Shift + F */
export function formatCombo(combo: Combo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl / ⌘");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  parts.push(KEY_LABEL[combo.key] ?? combo.key.toUpperCase());
  return parts.join(" + ");
}

function isCombo(v: unknown): v is Combo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ctrl === "boolean" &&
    typeof o.shift === "boolean" &&
    typeof o.alt === "boolean" &&
    typeof o.key === "string" &&
    o.key.length > 0
  );
}

type Overrides = Partial<Record<ShortcutId, Combo>>;

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Overrides = {};
    for (const { id } of CUSTOMIZABLE_SHORTCUTS) {
      const v = parsed[id];
      if (isCombo(v) && isBindableCombo(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(overrides: Overrides) {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

/** 默认值 + 用户覆盖 = 当前生效组合 */
function resolve(overrides: Overrides): Record<ShortcutId, Combo> {
  return { ...DEFAULT_SHORTCUTS, ...overrides };
}

/** 剔除某个 id 的覆盖项，返回新对象（避免动态 delete） */
function withoutOverride(overrides: Overrides, id: ShortcutId): Overrides {
  const next: Overrides = {};
  for (const def of CUSTOMIZABLE_SHORTCUTS) {
    const v = overrides[def.id];
    if (def.id !== id && v) next[def.id] = v;
  }
  return next;
}

interface ShortcutsState {
  /** 用户自定义的覆盖项（仅存与默认不同的项） */
  overrides: Overrides;
  /** 当前生效的组合 */
  combos: Record<ShortcutId, Combo>;
  /** 设置绑定；与其它快捷键冲突时返回 false 且不生效 */
  setShortcut: (id: ShortcutId, combo: Combo) => boolean;
  resetShortcut: (id: ShortcutId) => void;
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()((set, get) => {
  const initial = loadOverrides();
  return {
    overrides: initial,
    combos: resolve(initial),
    setShortcut: (id, combo) => {
      const conflict = CUSTOMIZABLE_SHORTCUTS.some(
        ({ id: other }) => other !== id && comboEquals(get().combos[other], combo),
      );
      if (conflict) return false;
      const overrides = comboEquals(combo, DEFAULT_SHORTCUTS[id])
        ? withoutOverride(get().overrides, id)
        : { ...get().overrides, [id]: combo };
      persist(overrides);
      set({ overrides, combos: resolve(overrides) });
      return true;
    },
    resetShortcut: (id) => {
      const overrides = withoutOverride(get().overrides, id);
      persist(overrides);
      set({ overrides, combos: resolve(overrides) });
    },
    resetAll: () => {
      persist({});
      set({ overrides: {}, combos: resolve({}) });
    },
  };
});

/** 冲突时返回占用的快捷键 id（用于提示文案） */
export function findConflict(id: ShortcutId, combo: Combo): ShortcutId | null {
  const { combos } = useShortcutsStore.getState();
  for (const { id: other } of CUSTOMIZABLE_SHORTCUTS) {
    if (other !== id && comboEquals(combos[other], combo)) return other;
  }
  return null;
}
