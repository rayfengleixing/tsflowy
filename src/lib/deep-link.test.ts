import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { bindFakeApp, type FakeApp } from "@/test/app-fakes";
import { viewNode } from "@/test/view-node";
import { openRowInView, parseDeepLink, rowPermalink } from "./deep-link";

describe("parseDeepLink", () => {
  it("解析标准 page 深链，无行级目标", () => {
    expect(parseDeepLink("tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab")).toEqual({
      viewId: "8f2f1a34-5678-4abc-9def-0123456789ab",
      rowId: null,
    });
  });

  it("容忍 query 与 hash", () => {
    expect(parseDeepLink("tsflowy://page/abc?mode=edit#top")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc#frag")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc/?x=1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("取出 ?row= 行级目标（可在其它键之后、可被编码）", () => {
    expect(parseDeepLink("tsflowy://page/abc?row=r1")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc?mode=edit&row=r1#top")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc?row=r1&row=r2")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc#row=r1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("行 id 只认安全字符集：带引号/斜杠/超长的一律当没有行级目标", () => {
    // rowFocus 用 [data-row-id="…"] 选择器定位，脏值会让 querySelector 直接抛错
    expect(parseDeepLink('tsflowy://page/abc?row=r1"x')).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=a/b")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=" + "x".repeat(65))).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=%20r1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("容忍前后空白与大小写", () => {
    expect(parseDeepLink("  TsFlowy://Page/abc?row=r1  ")).toEqual({ viewId: "abc", rowId: "r1" });
  });

  it("解码 percent-encoded 视图 id", () => {
    expect(parseDeepLink("tsflowy://page/a%20b")).toEqual({ viewId: "a b", rowId: null });
  });

  it("非法输入返回 null", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("https://page/abc")).toBeNull();
    expect(parseDeepLink("tsflowy://other/abc")).toBeNull();
    expect(parseDeepLink("tsflowy://page/")).toBeNull();
    expect(parseDeepLink("tsflowy://page")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  it("不吞掉编码错误的百分号序列", () => {
    expect(parseDeepLink("tsflowy://page/100%")).toEqual({ viewId: "100%", rowId: null });
  });
});

describe("rowPermalink", () => {
  it("产出的链接能被 parseDeepLink 原样读回", () => {
    const url = rowPermalink("8f2f1a34-5678-4abc-9def-0123456789ab", "r_1-2");
    expect(url).toBe("tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab?row=r_1-2");
    expect(parseDeepLink(url)).toEqual({ viewId: "8f2f1a34-5678-4abc-9def-0123456789ab", rowId: "r_1-2" });
  });

  it("视图 id 里的保留字符转义后仍能还原", () => {
    expect(parseDeepLink(rowPermalink("a b/c", "r1"))).toEqual({ viewId: "a b/c", rowId: "r1" });
  });
});

// 排队跳转这一段以前只能靠 vi.mock("@/stores/workspace") 整条 store 替身才测得到；
// 现在它只认 lib/app-context 注册表，用例把运行态绑上就能跑（见 src/test/app-fakes.ts）。
describe("openRowInView：等页面树里有目标页再跳转", () => {
  let app: FakeApp;

  beforeEach(() => {
    app = bindFakeApp();
  });

  afterEach(() => {
    app.dispose();
    vi.useRealTimers();
  });

  it("目标页已在树里：立刻开页，行级目标跟着落到行聚焦", () => {
    app.set({ tree: [viewNode("v-1", "某页")] });

    openRowInView("v-1", "r-9");

    expect(app.actions.openView).toHaveBeenCalledWith("v-1");
    expect(app.actions.setFocusRow).toHaveBeenCalledWith("r-9");
  });

  it("只要页不要行：不传 rowId 就不碰行聚焦", () => {
    app.set({ tree: [viewNode("v-1", "某页")] });

    openRowInView("v-1");

    expect(app.actions.openView).toHaveBeenCalledWith("v-1");
    expect(app.actions.setFocusRow).not.toHaveBeenCalled();
  });

  it("子树里的页面也算命中", () => {
    app.set({ tree: [viewNode("v-parent", "父页", { children: [viewNode("v-1", "子页")] })] });

    openRowInView("v-1");

    expect(app.actions.openView).toHaveBeenCalledWith("v-1");
  });

  it("树里还没有：先订阅等着，页面出现才开，命中后不再重复开", () => {
    openRowInView("v-1", "r-9");

    expect(app.actions.subscribeWorkspace).toHaveBeenCalledTimes(1);
    expect(app.actions.openView).not.toHaveBeenCalled();

    app.set({ tree: [viewNode("v-1", "某页")] });
    app.emitWorkspaceChange();

    expect(app.actions.openView).toHaveBeenCalledWith("v-1");
    expect(app.actions.setFocusRow).toHaveBeenCalledWith("r-9");

    // 命中即退订：之后树再怎么变都不该再开一次页
    app.set({ tree: [] });
    app.emitWorkspaceChange();
    expect(app.actions.openView).toHaveBeenCalledTimes(1);
  });

  it("等满超时放弃：记一次日志并退订，页面后来出现也不跳", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    openRowInView("v-gone");
    vi.advanceTimersByTime(15000);

    expect(app.actions.openView).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("deep-link", expect.any(String), "v-gone");

    app.set({ tree: [viewNode("v-gone", "来晚了")] });
    app.emitWorkspaceChange();
    expect(app.actions.openView).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("没绑定运行态时直接抛，不会静默当成「页面不存在」", () => {
    app.dispose();

    expect(() => openRowInView("v-1")).toThrow(/app-context/);
  });
});
