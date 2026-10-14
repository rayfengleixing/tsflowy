import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const viewApi = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/db", () => ({ viewApi }));

import {
  CLOSED_STACK_LIMIT,
  flushPendingUiPersist,
  loadSidebarWidth,
  loadTabsForWs,
  persistNow,
  popReopenable,
  pushClosedId,
  saveSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
} from "./persistence";
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

  it("expanded 从未持久化返回 null；已持久化则过滤掉树里不存在的 id", async () => {
    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:expanded:ws1") return Promise.resolve('["a","gone","b"]');
      return Promise.resolve(null);
    });
    const r = await loadTabsForWs("ws1", treeOf("a", "b"));
    expect(r.expanded).toBeInstanceOf(Set);
    expect([...r.expanded!].sort()).toEqual(["a", "b"]);
  });

  it("expanded 空数组保留为空 Set（与 null 语义区分）；损坏 JSON 视作未持久化", async () => {
    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:expanded:ws1") return Promise.resolve("[]");
      return Promise.resolve(null);
    });
    const empty = await loadTabsForWs("ws1", treeOf("a"));
    expect(empty.expanded).toEqual(new Set<string>());

    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:expanded:ws1") return Promise.resolve("not-json");
      return Promise.resolve(null);
    });
    const broken = await loadTabsForWs("ws1", treeOf("a"));
    expect(broken.expanded).toBeNull();
  });

  it("pinned 只保留仍在 tabs 里的 id", async () => {
    viewApi.getSetting.mockImplementation((key: string) => {
      if (key === "ui:tabs:ws1") return Promise.resolve('["a","b"]');
      if (key === "ui:pinned:ws1") return Promise.resolve('["a","ghost","b","gone-tab"]');
      return Promise.resolve(null);
    });
    const r = await loadTabsForWs("ws1", treeOf("a", "b", "gone-tab"));
    expect([...r.pinned].sort()).toEqual(["a", "b"]);
  });
});

describe("persistNow + flushPendingUiPersist", () => {
  const state =
    (
      over: Partial<{
        tabs: View[];
        currentViewId: string | null;
        splitViewId: string | null;
        expanded: Set<string>;
        pinnedTabIds: Set<string>;
      }>,
    ) =>
    () =>
      ({
        currentWorkspaceId: "ws1",
        tabs: [],
        currentViewId: null,
        splitViewId: null,
        expanded: new Set<string>(),
        pinnedTabIds: new Set<string>(),
        ...over,
      }) as never;

  it("把 tabs/current/split/expanded/pinned 五键写回 app_settings", async () => {
    persistNow(
      state({
        tabs: [{ id: "a" }, { id: "b" }] as View[],
        currentViewId: "b",
        splitViewId: "a",
        expanded: new Set(["a"]),
        pinnedTabIds: new Set(["b"]),
      }),
    );
    await flushPendingUiPersist();
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:tabs:ws1", '["a","b"]');
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:current_view:ws1", "b");
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:split_view:ws1", "a");
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:expanded:ws1", '["a"]');
    expect(viewApi.setSetting).toHaveBeenCalledWith("ui:pinned:ws1", '["b"]');
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

describe("关闭栈纯函数", () => {
  it("pushClosedId：追加到末尾，重复 id 不重复入栈", () => {
    let s: string[] = [];
    s = pushClosedId(s, "a");
    s = pushClosedId(s, "b");
    s = pushClosedId(s, "a");
    expect(s).toEqual(["b", "a"]);
  });

  it("pushClosedId：超过 CLOSED_STACK_LIMIT 时丢最旧", () => {
    let s: string[] = [];
    for (let i = 0; i < CLOSED_STACK_LIMIT + 3; i++) s = pushClosedId(s, `id${i}`);
    expect(s).toHaveLength(CLOSED_STACK_LIMIT);
    expect(s[0]).toBe("id3");
    expect(s[s.length - 1]).toBe(`id${CLOSED_STACK_LIMIT + 2}`);
  });

  it("popReopenable：跳过已删除项，剩余栈保持原序", () => {
    const stack = ["a", "b", "c"];
    const valid = new Set(["a", "c"]);
    const r = popReopenable(stack, valid);
    expect(r.id).toBe("c");
    expect(r.stack).toEqual(["a", "b"]); // "b" 已失效也一并剔除
    const r2 = popReopenable(r.stack, valid);
    expect(r2.id).toBe("a");
    expect(r2.stack).toEqual([]);
  });

  it("popReopenable：栈空或全部失效返回 null 且清空", () => {
    const r = popReopenable(["x", "y"], new Set());
    expect(r.id).toBeNull();
    expect(r.stack).toEqual([]);
  });
});

describe("侧栏宽度 localStorage", () => {
  const storage = new Map<string, string>();
  beforeAll(() => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
  });
  beforeEach(() => storage.clear());

  it("未存过时回落到默认 240", () => {
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("存过则回读；越界或非法值回落到默认", () => {
    saveSidebarWidth(320);
    expect(loadSidebarWidth()).toBe(320);
    storage.set("tsflowy:sidebar-width", "abc");
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
    storage.set("tsflowy:sidebar-width", "9999");
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
