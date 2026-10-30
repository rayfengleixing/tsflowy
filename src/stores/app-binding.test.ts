// 收口的另一半：lib 只声明「要读什么、要做什么」，真正给值/干活的是 stores 模块求值时的那几次 bind。
// 这里不替身、直接拿真 store 验绑定关系——哪天绑定被删、或绑成了快照而不是取值函数，
// lib 侧读到的就会是旧值、调到的就是模块求值那一刻的旧方法，或干脆抛「还没有绑定」，这组用例先炸。
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewNode } from "@/test/view-node";

const syncNativeLang = vi.hoisted(() => vi.fn());
// settings → app-shell → invoke → auto-sync：node 环境没有真实 DOM，壳层行为本身在 lib/app-shell.test.ts 覆盖
vi.mock("@/lib/desktop/app-shell", () => ({ syncNativeLang }));

import {
  appInvalidateRelations,
  appLang,
  appOpenView,
  appReload,
  appRenameView,
  appSetFocusRow,
  appSetRoute,
  appSubscribeWorkspace,
  appTree,
  appWorkspaceId,
} from "@/lib/app-context";
import { t } from "@/lib/i18n";
import { useRelationStore } from "./relation";
import { useRowFocusStore } from "./row-focus";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";

// 注意：这里不调 resetAppReaders() / resetAppActions()——本文件验的正是 store 在模块求值时装上的那些绑定，
// 清了等于把被测对象清掉；改过的 lang / tree / 方法在用例内自己还原。

describe("stores 侧的语言绑定", () => {
  it("setLang 之后 lib 侧读到新语言，t() 跟着换字典", () => {
    useSettingsStore.setState({ lang: "en-US" });
    expect(appLang()).toBe("en-US");
    expect(t("common.untitled")).toBe("Untitled");
    useSettingsStore.setState({ lang: "zh-CN" });
    expect(appLang()).toBe("zh-CN");
    expect(t("common.untitled")).toBe("无标题页面");
  });
});

describe("stores 侧的页面树与工作区绑定", () => {
  it("store 里的树换了，lib 侧立刻读到新的那一份", () => {
    useWorkspaceStore.setState({ tree: [], currentWorkspaceId: null });
    expect(appTree()).toEqual([]);
    expect(appWorkspaceId()).toBeNull();

    useWorkspaceStore.setState({ tree: [viewNode("v1", "首页")], currentWorkspaceId: "ws-9" });
    expect(appTree().map((v) => v.name)).toEqual(["首页"]);
    expect(appWorkspaceId()).toBe("ws-9");
  });
});

// workspace 那四个动作把 store 上的方法临时换成 spy：既证明键真的绑上了，
// 也证明绑的是「取当前方法」而不是模块求值那一刻的函数快照——绑成快照的话这里换成 spy 就调不到了，
// 而真实现会在 node 环境里去碰 IPC，用例直接红。
describe("stores 侧的写动作绑定", () => {
  const originals = {
    reload: useWorkspaceStore.getState().reload,
    renameView: useWorkspaceStore.getState().renameView,
    openView: useWorkspaceStore.getState().openView,
    setRoute: useWorkspaceStore.getState().setRoute,
  };

  afterEach(() => {
    useWorkspaceStore.setState(originals);
    useRowFocusStore.getState().clearFocusRow();
  });

  it("reload / renameView / openView / setRoute 打到 store 上当前的那几个方法", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const renameView = vi.fn().mockResolvedValue(undefined);
    const openView = vi.fn();
    const setRoute = vi.fn();
    useWorkspaceStore.setState({ reload, renameView, openView, setRoute });

    await appReload();
    await appRenameView("v1", "改了名");
    appOpenView("v1");
    appSetRoute("settings");

    expect(reload).toHaveBeenCalledTimes(1);
    expect(renameView).toHaveBeenCalledWith("v1", "改了名");
    expect(openView).toHaveBeenCalledWith("v1");
    expect(setRoute).toHaveBeenCalledWith("settings");
  });

  it("行聚焦与关联失效落到真 store 的状态上", () => {
    appSetFocusRow("r-7");
    expect(useRowFocusStore.getState().focusRowId).toBe("r-7");

    const revision = useRelationStore.getState().revision;
    appInvalidateRelations(["v1"]);
    expect(useRelationStore.getState().revision).toBe(revision + 1);
  });

  it("subscribeWorkspace 是真 store 订阅，注销函数管用", () => {
    const tree = useWorkspaceStore.getState().tree;
    const listener = vi.fn();

    const unsubscribe = appSubscribeWorkspace(listener);
    useWorkspaceStore.setState({ tree: [viewNode("v1", "首页")] });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    useWorkspaceStore.setState({ tree });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
