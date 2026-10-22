import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会被提到文件最前，工厂里不能引用顶层 import 的绑定，
// 所以用动态 import 取替身：同一测试文件里模块是单例，工厂返回的与下面静态导入的是同一份。
vi.mock("@/lib/ipc-core", async () => (await import("./tauri-mock")).ipcCoreMock());
vi.mock("@/lib/ipc-events", async () => (await import("./tauri-mock")).ipcEventsMock());
vi.mock("@/lib/ipc-dialog", async () => (await import("./tauri-mock")).ipcDialogMock());
vi.mock("@/lib/ipc-fs", async () => (await import("./tauri-mock")).ipcFsMock());
vi.mock("@/lib/ipc-shell", async () => (await import("./tauri-mock")).ipcShellMock());

// 这个文件证明的是「替身本身可用」：命令按名字命中、没注册就抛、事件能被喂进真实消费者，
// 对话框排队与假目录树也照同一口径（未登记就抛，别把空列表当成扫描通过）。
// 替身分别顶掉 @/lib/ipc-core、ipc-events、ipc-dialog、ipc-fs、ipc-shell —— 全仓引 @tauri-apps 的五个入口。
import { SYNC_DB_REPLACED_EVENT, SYNC_PROGRESS_EVENT, onSyncProgress, startSyncEvents } from "@/lib/sync-events";
import { aiChat, type AiChatEvent } from "@/lib/ai";
import { bindFakeApp } from "./app-fakes";
import { viewNode } from "./view-node";
import {
  MockChannel,
  callsFor,
  closeRequests,
  deepLinkGetCurrent,
  deepLinkListenerAttached,
  deepLinkOnOpenUrl,
  dialogCalls,
  emitDeepLinkUrl,
  emitMockEvent,
  failDeepLinkGetCurrent,
  failNextOpenUrl,
  fsWrites,
  installedUpdates,
  lastChannel,
  listenerCount,
  openUrl,
  openedUrls,
  queueDeepLinkStartup,
  queueOpenDialog,
  queueUpdateCheck,
  requestWindowClose,
  resetIpcMock,
  setIpcHandler,
  setIpcHandlers,
  setFsDir,
  setFsFile,
  windowDestroy,
} from "./tauri-mock";

describe("tauri-mock 的命令侧", () => {
  beforeEach(() => {
    resetIpcMock();
  });

  it("按命令名注册返回值，参数原样记下来", async () => {
    setIpcHandlers({
      doc_load: (args) => ({ id: args?.viewId, title: "替身标题" }),
      doc_save: () => undefined,
    });

    const { invoke } = await import("@/lib/invoke");
    const loaded = await invoke<{ id: string; title: string }>("doc_load", { viewId: "v-1" });

    expect(loaded).toEqual({ id: "v-1", title: "替身标题" });
    expect(callsFor("doc_load")).toEqual([{ cmd: "doc_load", args: { viewId: "v-1" } }]);
  });

  it("没注册的命令直接抛，不静默回 undefined", async () => {
    const { invoke } = await import("@/lib/invoke");
    await expect(invoke("never_registered")).rejects.toThrow(/never_registered/);
  });

  it("路径与 asset URL 也走同一个替身", async () => {
    const { getAppDataDir, resolveAssetUrl } = await import("@/lib/assets");
    expect(await getAppDataDir()).toBe("/mock/app-data");
    expect(await resolveAssetUrl("assets/a.png")).toBe("/mock/app-data/assets/a.png");
  });

  it("Channel 实例可被测试主动投喂，回调打到调用方", async () => {
    setIpcHandler("ai_chat", () => undefined);
    const seen: AiChatEvent[] = [];

    await aiChat([{ role: "user", content: "你好" }], (ev) => seen.push(ev));

    expect(callsFor("ai_chat")[0].args?.onEvent).toBeInstanceOf(MockChannel);

    lastChannel<AiChatEvent>()?.deliver({ type: "chunk", delta: "第一段" });
    lastChannel<AiChatEvent>()?.deliver({ type: "chunk", delta: "第二段" });
    expect(seen.map((e) => e.type)).toEqual(["chunk", "chunk"]);
    expect(seen[1]).toEqual({ type: "chunk", delta: "第二段" });
  });
});

describe("tauri-mock 的事件侧（真实消费者 sync-events）", () => {
  beforeEach(() => {
    resetIpcMock();
  });

  it("startSyncEvents 注册的监听器能被喂帧，done 帧转成 null", async () => {
    await startSyncEvents();
    expect(listenerCount(SYNC_PROGRESS_EVENT)).toBe(1);
    expect(listenerCount(SYNC_DB_REPLACED_EVENT)).toBe(1);

    const frames: unknown[] = [];
    onSyncProgress((p) => frames.push(p));

    emitMockEvent(SYNC_PROGRESS_EVENT, { stage: "hash_local", done: 1, total: 4 });
    emitMockEvent(SYNC_PROGRESS_EVENT, { stage: "done", done: 4, total: 4 });

    expect(frames).toEqual([{ stage: "hash_local", done: 1, total: 4 }, null]);
  });

  it("没人监听的事件返回 0，而不是假装触发成功", () => {
    expect(emitMockEvent("sync:nobody-listens", {})).toBe(0);
  });

  it("退订后不再收帧", async () => {
    await startSyncEvents();
    const frames: unknown[] = [];
    const off = onSyncProgress((p) => frames.push(p));
    off();

    emitMockEvent(SYNC_PROGRESS_EVENT, { stage: "assets", done: 1, total: 2 });
    expect(frames).toEqual([]);
  });

  it("监听器数量随 unlisten 回落（替身跟真事件同构）", async () => {
    const { listen } = await import("@/lib/ipc-events");
    const handler = vi.fn();
    const un = await listen("probe", handler);
    expect(listenerCount("probe")).toBe(1);

    emitMockEvent("probe", { hello: 1 });
    expect(handler).toHaveBeenCalledWith({ payload: { hello: 1 } });

    un();
    expect(listenerCount("probe")).toBe(0);
    expect(emitMockEvent("probe", {})).toBe(0);
    expect(vi.isMockFunction(listen)).toBe(true);
  });
});

describe("tauri-mock 的对话框与文件侧", () => {
  beforeEach(() => {
    resetIpcMock();
  });

  it("排队一次给一个结果，排空就按「用户取消」返回 null", async () => {
    const { open, save } = await import("@/lib/ipc-dialog");
    queueOpenDialog("D:/attachments");

    expect(await open({ directory: true })).toBe("D:/attachments");
    expect(await open({ directory: true })).toBeNull();
    expect(await save({ defaultPath: "a.csv" })).toBeNull();
    expect(dialogCalls.map((c) => c.kind)).toEqual(["open", "open", "save"]);
  });

  it("假目录树按登记命中，没登记的目录抛错而不是回空列表", async () => {
    const { readDir, readTextFile } = await import("@/lib/ipc-fs");
    setFsDir("D:/attachments", [
      { name: "a.png", isFile: true },
      { name: "sub", isDirectory: true },
    ]);
    setFsFile("D:/attachments/a.png", "binary-ish");

    expect((await readDir("D:\\attachments")).map((e) => e.name)).toEqual(["a.png", "sub"]);
    expect(await readTextFile("D:/attachments/a.png")).toBe("binary-ish");
    await expect(readDir("D:/nope")).rejects.toThrow(/D:\/nope/);
  });

  it("writeTextFile 只记录，不碰真磁盘", async () => {
    const { writeTextFile } = await import("@/lib/ipc-fs");
    await writeTextFile("D:\\out\\page.md", "# 标题");
    expect(fsWrites).toEqual([{ path: "D:/out/page.md", contents: "# 标题" }]);
  });

  it("join 替身把反斜杠统一成正斜杠，接缝不重复分隔符", async () => {
    const { join } = await import("@/lib/ipc-core");
    expect(await join("D:\\attachments\\", "/sub/", "b.png")).toBe("D:/attachments/sub/b.png");
  });
});

describe("tauri-mock 的系统侧（ipc-shell）", () => {
  beforeEach(() => {
    resetIpcMock();
  });

  it("关窗请求交给处理器裁决：preventDefault 记下来，放行才走到 destroy", async () => {
    const { getCurrentWindow } = await import("@/lib/ipc-shell");
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await windowDestroy();
    });

    expect(await requestWindowClose()).toBe(true);
    expect(closeRequests[0]).toEqual({ prevented: true });
    expect(windowDestroy).toHaveBeenCalledTimes(1);
  });

  it("没注册关窗处理器时 requestWindowClose 报 false（别把没人管当成已拦住）", async () => {
    expect(await requestWindowClose()).toBe(false);
    expect(windowDestroy).not.toHaveBeenCalled();
  });

  it("openUrl 记下每一次尝试，failNextOpenUrl 让下一次落到调用方的 catch", async () => {
    expect(await openUrl("https://example.com")).toBeUndefined();
    failNextOpenUrl("系统拒绝");
    await expect(openUrl("mailto:a@b.c")).rejects.toThrow("系统拒绝");
    expect(openedUrls).toEqual(["https://example.com", "mailto:a@b.c"]);
  });

  it("更新：排队给版本就走完下载→安装并记账，没排队就抛", async () => {
    const { check, relaunch } = await import("@/lib/ipc-shell");
    await expect(check()).rejects.toThrow(/queueUpdateCheck/);

    queueUpdateCheck("0.9.0");
    const update = await check();
    const events: string[] = [];
    await update?.downloadAndInstall((e) => events.push(e.event));
    expect(events).toEqual(["Finished"]);
    expect(installedUpdates).toEqual([{ version: "0.9.0", events: ["Finished"], installed: true }]);

    await relaunch();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("真实消费者 setupDeepLink：热启动监听装上、冷启动 URL 被消费、注销后摘掉", async () => {
    const { setupDeepLink } = await import("@/lib/deep-link");
    queueDeepLinkStartup(["https://not-a-tsflowy-link"]);

    const dispose = await setupDeepLink();
    expect(deepLinkGetCurrent).toHaveBeenCalledTimes(1);
    expect(deepLinkOnOpenUrl).toHaveBeenCalledTimes(1);
    expect(deepLinkListenerAttached()).toBe(true);

    // 解析不出 viewId 的地址由 deep-link 自己忽略，不该在边界外抛错
    expect(emitDeepLinkUrl("https://not-a-tsflowy-link")).toBe(true);
    dispose();
    expect(deepLinkListenerAttached()).toBe(false);
  });

  it("getCurrent 失败只记日志，不拖累 onOpenUrl 那条腿", async () => {
    const { setupDeepLink } = await import("@/lib/deep-link");
    // 命中的 URL 会走排队跳转（读页面树 + 订阅 + openView），这里把运行态绑上再验 IPC 那条腿
    const app = bindFakeApp({ tree: [viewNode("v-1", "某页")] });
    failDeepLinkGetCurrent();

    const dispose = await setupDeepLink();
    expect(dispose).toBeTypeOf("function");
    expect(emitDeepLinkUrl("tsflowy://page/v-1?row=a/b")).toBe(true);
    expect(app.actions.openView).toHaveBeenCalledWith("v-1");
    // row=a/b 不合行 id 形态，解析阶段就丢了，不该跑到行聚焦
    expect(app.actions.setFocusRow).not.toHaveBeenCalled();
    dispose();
    app.dispose();
  });
});
