// t() 与 useLanguage() 的语言来源单点验证。本文件刻意跑在默认 node 环境（无 window、无 localStorage）：
// 迁移前 t() 直接 useSettingsStore.getState()，等于把整条 settings store（含 localStorage 读写）
// 拖进每一次取文案；现在 lib 只认 app-context，取不到绑定时落默认语言——这正是这组用例要钉住的形状。
import { afterEach, describe, expect, it } from "vitest";

import { bindAppReaders, resetAppActions, resetAppReaders } from "./app-context";
import { LANGUAGES, type LangCode } from "./i18n/languages";
import { t, useLanguage } from "./i18n";

afterEach(() => resetAppReaders());

describe("t() 的语言来源", () => {
  it("没有任何绑定时取注册表首项，而不是抛错", () => {
    expect(typeof window).toBe("undefined");
    expect(LANGUAGES[0].code).toBe("zh-CN");
    expect(t("common.untitled")).toBe("无标题页面");
  });

  it("绑定语言后同一调用切到该语言字典，{placeholder} 插值照旧", () => {
    bindAppReaders({ getLang: () => "en-US" });
    expect(t("common.untitled")).toBe("Untitled");
    expect(t("outline.untitled", { level: "H2" })).toBe("Untitled H2");
  });

  it("切换语言是取值函数在生效，不需要重新加载模块", () => {
    let lang: LangCode = "zh-CN";
    bindAppReaders({ getLang: () => lang });
    expect(t("common.untitled")).toBe("无标题页面");
    lang = "en-US";
    expect(t("common.untitled")).toBe("Untitled");
  });
});

// useLanguage() 不再直连 settings store，改由 app-context 用 useSyncExternalStore 组：
// stores 交「怎么订阅」（subscribeLang），读的仍是 appLang() 那一份。
// 真渲染那一半要 React，分别在 src/lib/use-language.test.tsx（假订阅）与
// src/stores/app-binding-lang.test.tsx（真 store 绑定）里跑 jsdom 验；
// 这个文件跑在无 window 的 node 环境，只钉住兜底口径：没绑必须当场抛，
// 不能悄悄退化成「读一次值不刷新」，也不能让 React 拿到一个 undefined 的 subscribe。
describe("useLanguage() 的订阅来源", () => {
  afterEach(() => resetAppActions());

  it("没有绑定时直接抛，不悄悄退化成读一次当前语言", () => {
    expect(() => useLanguage()).toThrow(/subscribeLang/);
  });

  it("只绑了语言读取、没绑订阅时同样是抛（两项各管各的，缺一项不静默降级）", () => {
    bindAppReaders({ getLang: () => "en-US" });
    expect(t("common.untitled")).toBe("Untitled");
    expect(() => useLanguage()).toThrow(/subscribeLang/);
    resetAppReaders();
  });
});
