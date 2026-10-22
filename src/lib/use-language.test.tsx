// @vitest-environment jsdom
// useLanguage() 换源后的脱 store 用例：它现在只认 app-context（订阅来自 bindFakeApp 的假动作，
// 语言值来自假读取），整条 settings store 不再参与——这正是这次迁移要买到的东西：
// 「切语言后订阅方重渲染」这条形状，不起 Tauri、不引 store 也能在 jsdom 里跑。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindFakeApp, type FakeApp } from "@/test/app-fakes";
import { useLanguage } from "./i18n";

let app: FakeApp;

beforeEach(() => {
  app = bindFakeApp({ lang: "zh-CN" });
});

afterEach(() => {
  cleanup();
  app.dispose();
});

function Probe() {
  return <span data-testid="probe">{useLanguage()}</span>;
}

describe("useLanguage() 走注册表订阅", () => {
  it("挂载时读到当前语言", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("zh-CN");
  });

  it("假订阅被真的用上了：触发一次语言变化就重渲染成新值", () => {
    render(<Probe />);

    act(() => {
      app.set({ lang: "en-US" });
      app.emitLangChange();
    });

    expect(screen.getByTestId("probe").textContent).toBe("en-US");
    expect(app.actions.subscribeLang).toHaveBeenCalledTimes(1);
  });

  it("只改值不触发订阅就不重渲染（订阅是唯一的唤起口）", () => {
    render(<Probe />);

    act(() => {
      app.set({ lang: "en-US" });
    });

    expect(screen.getByTestId("probe").textContent).toBe("zh-CN");
  });

  it("组件卸载后取消订阅，多余的广播打不到它", () => {
    render(<Probe />);
    cleanup();

    // 假 subscribeLang 返回的注销函数被 useSyncExternalStore 在卸载时调过，监听者已清空
    expect(() => act(() => app.emitLangChange())).not.toThrow();
  });
});
