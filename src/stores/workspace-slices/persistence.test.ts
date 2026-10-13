import { beforeEach, describe, expect, it, vi } from "vitest";

const viewApi = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/db", () => ({ viewApi }));

import { flushPendingUiPersist, loadTabsForWs, persistNow } from "./persistence";
import type { View, ViewNode } from "@/types/models";

// 构造最小 ViewNode：只覆盖 loadTabsForWs 用到的 id 字段
function node(id: string): ViewNode {
  return { id } as ViewNode;
}

function treeOf(...ids: string[]): ViewNode[] {
  return ids.map((id) => ({ ...node(id), children: [] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  viewApi.setSetting.mockResolvedValue(undefined);
});

describe("loadTabsForWs", () => {
  it("恢复 tabs/current/split；current 缺失时落到第一个标签", async () => {
    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:tabs:ws1") return Promise.resolve('["a","b"]');
      if (key === "ui:current_view:ws1") return Promise.resolve("");
      if (key === "ui:split_view:ws1") return Promise.resolve("b");
      return Promise.resolve(null);
    });
    const r = await loadTabsForWs("ws1", treeOf("a", "b"));
    expect(r.tabs.map((v) => v.id)).toEqual(["a", "b"]);
    expect(r.currentViewId).toBe("a"); // "" 哨兵 → 无 current → 第一个
    expect(r.splitViewId).toBe("b");
  });

  it("split 与主视图同页 / 不在树里 / 空哨兵时都丢弃", async () => {
    const base = { "ui:tabs:ws1": '["a","b"]', "ui:current_view:ws1": "a" };
    const cases: [string, string | null][] = [
      ["ui:split_view:ws1-same", null],
      ["", null],
      ["ghost", null],
    ];
    for (const [splitRaw, expected] of cases) {
      viewApi.getSetting.mockImplementation((key: string) => {
        if (key === "ui:split_view:ws1") {
          return Promise.resolve(splitRaw === "ui:split_view:ws1-same" ? "a" : splitRaw);
        }
        return Promise.resolve((base as Record<string, string>)[key] ?? null);
      });
      const r = await loadTabsForWs("ws1", treeOf("a", "b"));
      expect(r.splitViewId).toBe(expected);
    }
    // 合法 split 作为对照组：确认上面的丢弃不是恒 null
    viewApi.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === "ui:split_view:ws1" ? "b" : ((base as Record<string, string>)[key] ?? null)),
    );
    expect((await loadTabsForWs("ws1", treeOf("a", "b"))).splitViewId).toBe("b");
  });

  it("tabs 里的悬空 id 被过滤，不阻断恢复", async () => {
    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:tabs:ws1") return Promise.resolve('["a","gone","b"]');
      return Promise.resolve(null);
    });
    const r = await loadTabsForWs("ws1", treeOf("a", "b"));
    expect(r.tabs.map((v) => v.id)).toEqual(["a", "b"]);
    expect(r.currentViewId).toBe("a");
  });
});

describe("persistNow + flushPendingUiPersist", () => {
  const state = (over: Partial<{ tabs: View[]; currentViewId: string | null; splitViewId: string | null }>) => () =>
    ({
      currentWorkspaceId: "ws1",
      tabs: [],
      currentViewId: null,
      splitViewId: null,
      ...over,
    }) as never;

  it("把 tabs/current/split 三键写回 app_settings", async () => {
    persistNow(
      state({
        tabs: [{ id: "a" }, { id: "b" }] as View[],
        currentViewId: "b",
        splitViewId: "a",
      }),
    );
    await flushPendingUiPersist();
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:tabs:ws1", '["a","b"]');
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:current_view:ws1", "b");
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:split_view:ws1", "a");
  });

  it("关闭并排（split=null）写空串哨兵，而不是留旧值", async () => {
    persistNow(state({ tabs: [{ id: "a" }] as View[], currentViewId: "a", splitViewId: null }));
    await flushPendingUiPersist();
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:split_view:ws1", "");
  });

  it("无挂起写入时 flush 快速返回，不产生任何 setSetting", async () => {
    await flushPendingUiPersist();
    expect(viewApi.setSetting).not.toHaveBeenCalled();
  });
});
