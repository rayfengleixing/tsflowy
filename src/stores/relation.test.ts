import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listFields: vi.fn(),
  listRows: vi.fn(),
  loadCells: vi.fn(),
}));

vi.mock("@/lib/backend/database", () => ({ databaseApi: api }));

import { useRelationStore } from "@/stores/relation";

function stubFetch() {
  api.listFields.mockResolvedValue([{ id: "f1", name: "n" }]);
  api.listRows.mockResolvedValue([{ id: "r1" }]);
  api.loadCells.mockResolvedValue({ r1: { f1: "x" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useRelationStore.setState({ data: {}, revision: 0 });
  stubFetch();
});

describe("relation store 快照缓存", () => {
  it("ensure 已缓存的目标库不重复请求", async () => {
    useRelationStore.getState().ensure(["v1"]);
    await vi.waitFor(() => expect(useRelationStore.getState().data.v1).toBeDefined());
    useRelationStore.getState().ensure(["v1"]);
    await Promise.resolve();
    expect(api.listFields).toHaveBeenCalledTimes(1);
  });

  it("invalidate 丢弃快照并递增 revision，ensure 重新拉取", async () => {
    useRelationStore.getState().ensure(["v1", "v2"]);
    await vi.waitFor(() => expect(useRelationStore.getState().data).toHaveProperty("v2"));
    const rev = useRelationStore.getState().revision;
    useRelationStore.getState().invalidate(["v1"]);
    expect(useRelationStore.getState().data.v1).toBeUndefined();
    expect(useRelationStore.getState().data.v2).toBeDefined();
    expect(useRelationStore.getState().revision).toBe(rev + 1);
    useRelationStore.getState().ensure(["v1"]);
    await vi.waitFor(() => expect(api.listFields).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(useRelationStore.getState().data.v1).toBeDefined());
  });

  it("不带参数的 invalidate 清空全部", async () => {
    useRelationStore.getState().ensure(["v1", "v2"]);
    await vi.waitFor(() => expect(useRelationStore.getState().data).toHaveProperty("v2"));
    useRelationStore.getState().invalidate();
    expect(useRelationStore.getState().data).toEqual({});
  });
});
