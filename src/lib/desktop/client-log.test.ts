import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 这层的全部风险都在「什么时候真的走 IPC」：攒着不发会丢崩溃前的现场，逐条发会把序列化
// 压在主线程上，而日志出口自己报错如果往外抛就会绕回 logger 形成回环。这里把这几条钉住。
const invokeMock = vi.hoisted(() => vi.fn<(cmd: string, args: { lines: unknown[] }) => Promise<void>>());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { ClientLogLine } from "./client-log";

/** 第 n 次 IPC 送出去的行（mock 的参数是未定型 tuple，这里统一收成 ClientLogLine[]） */
function sentLines(callIndex = 0): ClientLogLine[] {
  return invokeMock.mock.calls[callIndex][1].lines as ClientLogLine[];
}

/** 所有 IPC 调用送出去的行的先后顺序 */
function allSent(): ClientLogLine[] {
  return invokeMock.mock.calls.flatMap((c) => c[1].lines as ClientLogLine[]);
}

/** 模块加载时读一次 window 判定是否在 Tauri 里，所以每个用例都要先把它摆好再 import */
async function freshModule() {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  vi.resetModules();
  return await import("./client-log");
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe("pushClientLog", () => {
  it("batches until the threshold is reached", async () => {
    const { pushClientLog } = await freshModule();
    for (let i = 0; i < 19; i++) pushClientLog("warn", `w${i}`);
    expect(invokeMock).not.toHaveBeenCalled();
    pushClientLog("warn", "w19");
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("write_client_logs");
    expect(args.lines).toHaveLength(20);
    expect(sentLines()[0]).toEqual({ level: "warn", message: "w0" });
  });

  it("flushes whatever is buffered when the timer fires", async () => {
    const { pushClientLog } = await freshModule();
    pushClientLog("info", "one");
    await vi.advanceTimersByTimeAsync(2999);
    expect(invokeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(sentLines()).toEqual([{ level: "info", message: "one" }]);
  });

  it("sends error level without waiting for the batch", async () => {
    const { pushClientLog } = await freshModule();
    pushClientLog("warn", "buffered");
    pushClientLog("error", "boom", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(sentLines().map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("gives up silently when the command is unavailable instead of looping", async () => {
    invokeMock.mockRejectedValue(new Error("not in tauri"));
    const { pushClientLog } = await freshModule();
    pushClientLog("error", "boom", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    pushClientLog("error", "again", true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when there is no Tauri IPC at all", async () => {
    // 浏览器里跑的前端、vitest 的 node 环境：没有 window.__TAURI_INTERNALS__ 就不该去撞命令
    delete (globalThis as { window?: unknown }).window;
    vi.resetModules();
    const { pushClientLog, flushClientLogs } = await import("./client-log");
    pushClientLog("error", "boom", true);
    await vi.runAllTimersAsync();
    await flushClientLogs();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the newest lines when an error storm overruns the buffer", async () => {
    const { pushClientLog } = await freshModule();
    // 同步刷 260 条：第一条起就占住在途名额，剩下的堆在缓冲里，超过上限先丢最旧的
    for (let i = 0; i < 260; i++) pushClientLog("warn", `w${i}`, true);
    await vi.runAllTimersAsync();
    const sent = allSent();
    expect(sent).toHaveLength(201);
    expect(sent[0].message).toBe("w0");
    expect(sent[1].message).toBe("w60");
    expect(sent[sent.length - 1].message).toBe("w259");
  });
});

describe("flushClientLogs", () => {
  it("hands the buffer over so a closing window does not swallow it", async () => {
    const { pushClientLog, flushClientLogs } = await freshModule();
    pushClientLog("warn", "before close");
    await flushClientLogs();
    expect(invokeMock.mock.calls[0][1].lines).toEqual([{ level: "warn", message: "before close" }]);
    await flushClientLogs();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("formatLogArgs", () => {
  it("keeps the context tag and expands errors and objects", async () => {
    const { formatLogArgs } = await freshModule();
    const err = new Error("nope");
    err.stack = "stack line";
    expect(formatLogArgs("load tabs", [err, { n: 1 }, null])).toBe('[load tabs] stack line {"n":1} null');
  });

  it("reports the kind for values JSON cannot handle", async () => {
    const { formatLogArgs } = await freshModule();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLogArgs(undefined, [cyclic, undefined])).toBe("[object] [undefined]");
  });
});
