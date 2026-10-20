import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ store: new Map<string, string>(), failNext: false }));

vi.mock("@/lib/db", () => ({
  viewApi: {
    getSetting: (key: string) => Promise.resolve(api.store.get(key) ?? null),
    setSetting: (key: string, value: string) => {
      if (api.failNext) return Promise.reject(new Error("db locked"));
      api.store.set(key, value);
      return Promise.resolve();
    },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CARET_MAX_PAGES, parseCaretMap, putCaret, readCaret, writeCaret, type CaretMap } from "@/lib/caret-memory";

const mark = (block: number, offset = 0, scrollTop = 0) => ({ block, offset, scrollTop });

beforeEach(() => {
  api.store.clear();
  api.failNext = false;
});

describe("parseCaretMap", () => {
  it("坏 JSON、非对象、字段不合法的条目一律丢掉", () => {
    expect(parseCaretMap("{ 这不是 json")).toEqual({});
    expect(parseCaretMap("[1,2]")).toEqual({});
    expect(parseCaretMap(null)).toEqual({});
    expect(
      parseCaretMap(JSON.stringify({ v1: mark(2, 3), v2: { block: -1, offset: 0 }, v3: "x", v4: { block: 1 } })),
    ).toEqual({
      v1: mark(2, 3),
    });
  });

  it("小数与负的滚动位置收成非负整数", () => {
    const raw = JSON.stringify({ v1: { block: 2.7, offset: 1.2, scrollTop: -5 } });
    expect(parseCaretMap(raw)).toEqual({ v1: mark(2, 1, 0) });
  });
});

describe("putCaret", () => {
  it("同一页覆盖写，且刚写的挪到末尾（末尾=最近使用）", () => {
    let map: CaretMap = { a: mark(0), b: mark(1) };
    map = putCaret(map, "a", mark(9), 10);
    expect(Object.keys(map)).toEqual(["b", "a"]);
    expect(map.a).toEqual(mark(9));
  });

  it("超出容量从最久未用那头丢", () => {
    let map: CaretMap = {};
    for (let i = 0; i < CARET_MAX_PAGES + 5; i++) map = putCaret(map, `v${i}`, mark(i), CARET_MAX_PAGES);
    const ids = Object.keys(map);
    expect(ids.length).toBe(CARET_MAX_PAGES);
    expect(ids[0]).toBe("v5");
    expect(ids[ids.length - 1]).toBe(`v${CARET_MAX_PAGES + 4}`);
    expect(map.v0).toBeUndefined();
  });
});

describe("readCaret / writeCaret", () => {
  it("按空间分开存：换空间读不到别的空间的记忆", async () => {
    await writeCaret("w1", "v1", mark(3, 7, 120));
    expect(await readCaret("w1", "v1")).toEqual(mark(3, 7, 120));
    expect(await readCaret("w2", "v1")).toBeNull();
    expect(api.store.get("ui:carets:w1")).toBeTruthy();
    expect(api.store.get("ui:carets:w2")).toBeUndefined();
  });

  it("写第二页不覆盖第一页", async () => {
    await writeCaret("w1", "v1", mark(1));
    await writeCaret("w1", "v2", mark(2));
    expect(parseCaretMap(api.store.get("ui:carets:w1"))).toEqual({ v1: mark(1), v2: mark(2) });
  });

  it("并发写不互相盖掉（读-改-写串行）", async () => {
    await Promise.all([
      writeCaret("w1", "v1", mark(1)),
      writeCaret("w1", "v2", mark(2)),
      writeCaret("w1", "v3", mark(3)),
    ]);
    expect(Object.keys(parseCaretMap(api.store.get("ui:carets:w1"))).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("库里是坏数据也能写回：整表重建而不是抛错", async () => {
    api.store.set("ui:carets:w1", "{{{");
    await writeCaret("w1", "v1", mark(1));
    expect(parseCaretMap(api.store.get("ui:carets:w1"))).toEqual({ v1: mark(1) });
  });

  it("落库失败只记日志：不 reject，也不影响后续写", async () => {
    api.failNext = true;
    await expect(writeCaret("w1", "v1", mark(1))).resolves.toBeUndefined();
    api.failNext = false;
    await writeCaret("w1", "v2", mark(2));
    expect(await readCaret("w1", "v2")).toEqual(mark(2));
  });
});
