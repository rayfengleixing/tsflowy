import { beforeEach, describe, expect, it, vi } from "vitest";

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
