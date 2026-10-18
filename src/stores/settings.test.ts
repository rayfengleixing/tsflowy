import { beforeEach, describe, expect, it, vi } from "vitest";

const syncNativeLang = vi.hoisted(() => vi.fn());

// settings → app-shell → invoke → auto-sync → sonner：node 环境没有真实 DOM，装不上；
// 壳层同步行为本身在 src/lib/app-shell.test.ts 里覆盖，这里只验调用点
vi.mock("@/lib/app-shell", () => ({ syncNativeLang }));

/** 最小 DOM/localStorage 桩（vitest environment=node）；仅覆盖 settings 模块实际用到的 API */
const storage = new Map<string, string>();

function stubDom() {
  const classList = () => ({ add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("document", {
    documentElement: { lang: "", style: { setProperty: vi.fn() }, classList: classList() },
    body: { classList: classList() },
  });
}

async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/settings");
  return mod.useSettingsStore;
}

beforeEach(() => {
  storage.clear();
  syncNativeLang.mockReset();
  stubDom();
});

describe("settings 持久化与语言切换", () => {
  it("无持久化数据时用默认值", async () => {
    const store = await loadStore();
    const s = store.getState();
    expect(s.lang).toBe("zh-CN");
    expect(s.theme).toBe("light");
    expect(s.font).toBe("sans");
  });

  it("setLang 写 localStorage 并同步 <html lang>；重启后恢复", async () => {
    const store = await loadStore();
    store.getState().setLang("en-US");
    expect(storage.get("tsflowy-lang")).toBe("en-US");
    expect((document.documentElement as { lang: string }).lang).toBe("en-US");
    expect(syncNativeLang).toHaveBeenCalledWith("en-US");

    // 模拟重启：重新加载模块后从 localStorage 恢复
    const reloaded = await loadStore();
    expect(reloaded.getState().lang).toBe("en-US");
  });

  it("setTheme 与 setFont 写入 localStorage；重启后恢复", async () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const store = await loadStore();
    store.getState().setTheme("dark");
    store.getState().setFont("serif");
    expect(storage.get("tsflowy-theme")).toBe("dark");
    expect(storage.get("tsflowy-font")).toBe("serif");

    const reloaded = await loadStore();
    expect(reloaded.getState().theme).toBe("dark");
    expect(reloaded.getState().font).toBe("serif");
  });
});

describe("编辑器模式开关", () => {
  it("默认全关：开着只读启动会让用户以为键盘坏了", async () => {
    const store = await loadStore();
    const s = store.getState();
    expect(s.editorReadonly).toBe(false);
    expect(s.typewriter).toBe(false);
    expect(s.focusMode).toBe(false);
  });

  it("只读与打字机写 localStorage 并跨重启恢复", async () => {
    const store = await loadStore();
    store.getState().setEditorReadonly(true);
    store.getState().setTypewriter(true);
    expect(storage.get("tsflowy:editor-readonly")).toBe("1");
    expect(storage.get("tsflowy:editor-typewriter")).toBe("1");

    store.getState().setEditorReadonly(false);
    expect(storage.get("tsflowy:editor-readonly")).toBe("0");

    const reloaded = await loadStore();
    expect(reloaded.getState().editorReadonly).toBe(false);
    expect(reloaded.getState().typewriter).toBe(true);
  });

  it("专注模式不落盘：重启后外壳回到可见状态，退出入口不该依赖上次留下的开关", async () => {
    const store = await loadStore();
    store.getState().setFocusMode(true);
    expect([...storage.keys()].filter((k) => k.includes("focus"))).toEqual([]);
    expect(store.getState().focusMode).toBe(true);

    const reloaded = await loadStore();
    expect(reloaded.getState().focusMode).toBe(false);
  });

  it("localStorage 里的脏值按关处理", async () => {
    storage.set("tsflowy:editor-readonly", "true");
    const store = await loadStore();
    expect(store.getState().editorReadonly).toBe(false);
  });
});
