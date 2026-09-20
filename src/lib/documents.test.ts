import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./mentions", () => ({ mentionsApi: { rebuildFor: vi.fn().mockResolvedValue(undefined) } }));

import { documentApi } from "./documents";

/** 可手动放行的 doc_save 队列：每个元素控制一次 invoke 的 resolve/reject */
function deferredSaves() {
  const pending: { content: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  invokeMock.mockImplementation((cmd: string, args: { content: string }) => {
    if (cmd !== "doc_save") return Promise.resolve(null);
    return new Promise<void>((resolve, reject) => {
      pending.push({ content: args.content, resolve, reject });
    });
  });
  return pending;
}

describe("documentApi.save 排队语义", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("在途期间的多次保存只落最新一份（mailbox 合并）", async () => {
    const pending = deferredSaves();
    const p1 = documentApi.save("v-merge", '{"n":1}');
    await vi.waitFor(() => expect(pending.length).toBe(1));
    const p2 = documentApi.save("v-merge", '{"n":2}'); // 覆盖 mail
    const p3 = documentApi.save("v-merge", '{"n":3}'); // 覆盖 mail
    pending[0].resolve();
    await vi.waitFor(() => expect(pending.length).toBe(2));
    expect(pending[1].content).toBe('{"n":3}'); // 中间态 2 被丢弃
    pending[1].resolve();
    await Promise.all([p1, p2, p3]);
    expect(pending.length).toBe(2);
  });

  it("保存失败后该文档仍能继续保存（不卡死在同一 rejected worker）", async () => {
    const pending = deferredSaves();
    const p1 = documentApi.save("v-retry", '{"n":1}');
    await vi.waitFor(() => expect(pending.length).toBe(1));
    const p2 = documentApi.save("v-retry", '{"n":2}'); // 在途 → 进 mail
    pending[0].reject(new Error("db locked"));
    await expect(p1).rejects.toThrow("db locked");
    await expect(p2).rejects.toThrow("db locked");

    // 关键回归：失败后下一次 save 必须真的发起 IPC，而不是只写 mailbox 无人消费
    const p3 = documentApi.save("v-retry", '{"n":3}');
    await vi.waitFor(() => expect(pending.length).toBe(2));
    expect(pending[1].content).toBe('{"n":3}');
    pending[1].resolve();
    await p3;
  });

  it("空闲态的失败也不影响下一次保存", async () => {
    const pending = deferredSaves();
    const p1 = documentApi.save("v-idle", '{"n":1}');
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0].reject(new Error("write failed"));
    await expect(p1).rejects.toThrow("write failed");

    const p2 = documentApi.save("v-idle", '{"n":2}');
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending[1].resolve();
    await p2;
  });
});
