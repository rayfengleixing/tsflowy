import { beforeEach, describe, expect, it, vi } from "vitest";

/** 最小 localStorage 桩（vitest environment=node） */
const storage = new Map<string, string>();

function stubStorage() {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
}

async function loadStore() {
  // 每个用例重新导入模块，避免 zustand 单例状态串场（也用于模拟「重启后恢复」）
  vi.resetModules();
  return import("./shortcuts");
}

/** 构造一个只含 eventToCombo 所需字段的事件对象 */
function keyEvent(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  } as KeyboardEvent;
}

beforeEach(() => {
  storage.clear();
  stubStorage();
});

describe("shortcuts 组合键工具", () => {
  it("normalizeKey：规范大小写、映射空格、忽略纯修饰键", async () => {
    const { normalizeKey } = await loadStore();
    expect(normalizeKey("K")).toBe("k");
    expect(normalizeKey("Tab")).toBe("tab");
    expect(normalizeKey(" ")).toBe("space");
    expect(normalizeKey("Control")).toBeNull();
    expect(normalizeKey("Shift")).toBeNull();
    expect(normalizeKey("Alt")).toBeNull();
    expect(normalizeKey("Meta")).toBeNull();
  });

  it("eventToCombo：把 ⌘ 归一到 ctrl，纯修饰键返回 null", async () => {
    const { eventToCombo } = await loadStore();
    expect(eventToCombo(keyEvent("K", { ctrl: true }))).toEqual({ ctrl: true, shift: false, alt: false, key: "k" });
    expect(eventToCombo(keyEvent("f", { meta: true, shift: true }))).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      key: "f",
    });
    expect(eventToCombo(keyEvent("Control", { ctrl: true }))).toBeNull();
  });

  it("formatCombo：按 Ctrl / ⌘ + Shift + 键 的顺序展示", async () => {
    const { formatCombo } = await loadStore();
    expect(formatCombo({ ctrl: true, shift: false, alt: false, key: "k" })).toBe("Ctrl / ⌘ + K");
    expect(formatCombo({ ctrl: true, shift: true, alt: false, key: "f" })).toBe("Ctrl / ⌘ + Shift + F");
    expect(formatCombo({ ctrl: true, shift: false, alt: false, key: "tab" })).toBe("Ctrl / ⌘ + Tab");
    expect(formatCombo({ ctrl: true, shift: false, alt: true, key: "k" })).toBe("Ctrl / ⌘ + Alt + K");
  });

  it("isBindableCombo：必须带 Ctrl/Alt 且不能是 Esc", async () => {
    const { isBindableCombo } = await loadStore();
    expect(isBindableCombo({ ctrl: true, shift: false, alt: false, key: "j" })).toBe(true);
    expect(isBindableCombo({ ctrl: false, shift: false, alt: true, key: "j" })).toBe(true);
    expect(isBindableCombo({ ctrl: false, shift: false, alt: false, key: "j" })).toBe(false);
    expect(isBindableCombo({ ctrl: true, shift: false, alt: false, key: "escape" })).toBe(false);
  });
});

describe("shortcuts store", () => {
  it("无持久化数据时用默认组合", async () => {
    const { useShortcutsStore, DEFAULT_SHORTCUTS } = await loadStore();
    expect(useShortcutsStore.getState().combos).toEqual(DEFAULT_SHORTCUTS);
    expect(useShortcutsStore.getState().overrides).toEqual({});
  });

  it("setShortcut 生效并写入 localStorage，重启后恢复", async () => {
    const mod = await loadStore();
    const ok = mod.useShortcutsStore.getState().setShortcut("search", {
      ctrl: true,
      shift: false,
      alt: true,
      key: "g",
    });
    expect(ok).toBe(true);
    expect(mod.useShortcutsStore.getState().combos.search).toEqual({
      ctrl: true,
      shift: false,
      alt: true,
      key: "g",
    });

    // 重新加载模块模拟重启
    const reloaded = await loadStore();
    expect(reloaded.useShortcutsStore.getState().combos.search).toEqual({
      ctrl: true,
      shift: false,
      alt: true,
      key: "g",
    });
  });

  it("冲突的组合被拒绝，不改变现有绑定", async () => {
    const mod = await loadStore();
    // Ctrl+K 已被「打开命令面板」占用
    const ok = mod.useShortcutsStore.getState().setShortcut("search", {
      ctrl: true,
      shift: false,
      alt: false,
      key: "k",
    });
    expect(ok).toBe(false);
    expect(mod.useShortcutsStore.getState().combos.search).toEqual(mod.DEFAULT_SHORTCUTS.search);
  });

  it("设为默认值时不保留覆盖；resetAll 清空所有覆盖", async () => {
    const mod = await loadStore();
    mod.useShortcutsStore.getState().setShortcut("quickOpen", { ctrl: true, shift: false, alt: true, key: "o" });
    expect(mod.useShortcutsStore.getState().overrides.quickOpen).toBeDefined();

    mod.useShortcutsStore.getState().setShortcut("quickOpen", { ...mod.DEFAULT_SHORTCUTS.quickOpen });
    expect(mod.useShortcutsStore.getState().overrides.quickOpen).toBeUndefined();

    mod.useShortcutsStore.getState().setShortcut("search", { ctrl: true, shift: false, alt: true, key: "g" });
    mod.useShortcutsStore.getState().resetAll();
    expect(mod.useShortcutsStore.getState().combos).toEqual(mod.DEFAULT_SHORTCUTS);
    expect(storage.has("tsflowy-shortcuts")).toBe(false);
  });

  it("findConflict 返回占用的快捷键 id", async () => {
    const mod = await loadStore();
    expect(mod.findConflict("search", { ctrl: true, shift: false, alt: false, key: "k" })).toBe("commandPalette");
    expect(mod.findConflict("search", { ctrl: true, shift: false, alt: true, key: "g" })).toBeNull();
  });
});
