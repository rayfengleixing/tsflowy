// @vitest-environment jsdom
// 订阅侧收口的反方向守卫：lib/i18n 的 useLanguage() 只剩一行转发，真订阅由 stores/settings.ts 交进
// app-context 的 subscribeLang。这里不替身，在 jsdom 里真渲染探针组件：改 store 的语言后必须重渲染。
// 要是那次订阅给错了（比如绑了个从不回调的 subscribe，或快照取的是别的设置项），
// 表现是「切了语言界面不刷新」——线上没人报错，只有这一组用例拦得住。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const syncNativeLang = vi.hoisted(() => vi.fn());
// settings → app-shell → invoke → auto-sync：这里只要语言订阅的形状，壳层副作用不真跑
vi.mock("@/lib/app-shell", () => ({ syncNativeLang }));

import { t, useLanguage } from "@/lib/i18n";
import { useSettingsStore } from "./settings";

function LangProbe() {
  return (
    <span data-testid="probe">
      {useLanguage()}|{t("common.untitled")}
    </span>
  );
}

let renders = 0;
function CountingProbe() {
  renders++;
  return <span data-testid="count">{useLanguage()}</span>;
}

afterEach(() => {
  cleanup();
  renders = 0;
  useSettingsStore.setState({ lang: "zh-CN", typewriter: false });
});

describe("stores 侧的语言订阅绑定", () => {
  it("探针渲染出当前语言，改语言后同一次挂载就跟着换", () => {
    render(<LangProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("zh-CN|无标题页面");

    act(() => {
      useSettingsStore.setState({ lang: "en-US" });
    });
    expect(screen.getByTestId("probe").textContent).toBe("en-US|Untitled");
  });

  it("走 store 的真 setLang 也照样刷新（不只是 setState 那条捷径）", () => {
    render(<LangProbe />);

    act(() => {
      useSettingsStore.getState().setLang("en-US");
    });

    expect(screen.getByTestId("probe").textContent).toBe("en-US|Untitled");
    expect(syncNativeLang).toHaveBeenCalledWith("en-US");
  });

  it("挂载前就改过语言时，新挂载的探针读到的是新值（订阅取的是当场状态不是快照）", () => {
    act(() => {
      useSettingsStore.setState({ lang: "en-US" });
    });

    render(<LangProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("en-US|Untitled");
  });

  it("改别的设置项不连累语言订阅方重渲染（比的是语言那一份快照）", () => {
    render(<CountingProbe />);
    expect(renders).toBe(1);

    act(() => {
      useSettingsStore.setState({ typewriter: true });
    });
    expect(renders).toBe(1);

    act(() => {
      useSettingsStore.setState({ lang: "en-US" });
    });
    expect(renders).toBeGreaterThan(1);
    expect(screen.getByTestId("count").textContent).toBe("en-US");
  });
});
