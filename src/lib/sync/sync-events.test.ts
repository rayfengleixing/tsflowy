import { beforeEach, describe, expect, it, vi } from "vitest";

// Rust 侧的两个事件在前端只有一个注册点（src/lib/sync-events.ts）：
// 进度帧决定设置页那根条画什么，替换帧决定窗口要不要重载。
// 这里用事件替身直接喂帧，验证转发与闸门行为。
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => {
      handlers.delete(name);
    });
  }),
}));

const reload = vi.hoisted(() => vi.fn());
vi.stubGlobal("window", { location: { reload } });

function fire(stage: string, done: number, total: number) {
  handlers.get("sync:progress")?.({ payload: { stage, done, total } });
}

function fireReplaced() {
  handlers.get("sync:db-replaced")?.({ payload: null });
}

// reloadRequested 是模块级闸门：每个用例都要拿全新模块实例，否则第二个用例永远重载不了
async function freshEvents() {
  vi.resetModules();
  return await import("./sync-events");
}

beforeEach(() => {
  handlers.clear();
  reload.mockClear();
});

describe("同步进度事件", () => {
  it("阶段帧转发给订阅者，收尾 done 帧转发成 null（进度条据此收起）", async () => {
    const m = await freshEvents();
    const seen: unknown[] = [];
    m.onSyncProgress((p) => seen.push(p));
    fire("hash_local", 0, 1000);
    fire("assets", 3, 12);
    fire("done", 1, 1);
    expect(seen).toEqual([
      { stage: "hash_local", done: 0, total: 1000 },
      { stage: "assets", done: 3, total: 12 },
      null,
    ]);
  });

  it("退订后不再收帧；多订阅者各收一份", async () => {
    const m = await freshEvents();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = m.onSyncProgress((p) => a.push(p));
    m.onSyncProgress((p) => b.push(p));
    fire("snapshot", 0, 0);
    unsubA();
    fire("replace_db", 0, 0);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("本机库被替换即刻重载，且只重载一次（事件与命令返回值都会触发）", async () => {
    const m = await freshEvents();
    await m.startSyncEvents(); // App 启动时挂的那一次
    fireReplaced();
    expect(reload).toHaveBeenCalledTimes(1);
    // run_sync 返回的 pulled 兜底路径再来一次，不能把正在进行的整窗重载再排一遍
    m.requestSyncReload();
    fireReplaced();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("没挂上替换事件时，pulled 兜底仍然会重载", async () => {
    const m = await freshEvents();
    m.requestSyncReload();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("百分比：可预估时给数，预估不出（total=0）给 null，越界不超 100", async () => {
    const m = await freshEvents();
    expect(m.syncProgressPercent({ stage: "assets", done: 3, total: 12 })).toBe(25);
    expect(m.syncProgressPercent({ stage: "snapshot", done: 0, total: 0 })).toBeNull();
    expect(m.syncProgressPercent({ stage: "assets", done: 20, total: 12 })).toBe(100);
  });

  it("Rust 侧每个阶段都配了文案，未知阶段回落到通用文案而不是空串", async () => {
    const m = await freshEvents();
    for (const st of ["snapshot", "hash_local", "hash_remote", "replace_db", "assets", "tombstones"]) {
      expect(m.SYNC_STAGE_KEY[st], `阶段 {st} 忘了配文案`).toBeTruthy();
      expect(m.syncStageLabel({ stage: st, done: 0, total: 0 })).toBeTruthy();
    }
    // 前端版本落后于 Rust（新增阶段）时也要显示点什么
    expect(m.syncStageLabel({ stage: "brand_new", done: 0, total: 0 })).toBeTruthy();
  });
});
