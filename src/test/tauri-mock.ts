// IPC 替身：让组件测试只 mock 一个模块就能脱离 Tauri 运行
// （命令与路径走 vi.mock("@/lib/ipc-core", () => ipcCoreMock())，事件侧 ipc-events，
// 对话框 ipc-dialog，文件系统 ipc-fs，系统侧（窗口/版本号/openUrl/更新/深链）ipc-shell）。
//
// 口径是保守的：命令没注册就抛错，而不是静默返回 undefined —— 漏注册应当在第一个 await 处炸出来，
// 而不是让组件渲染成「数据恰好是空的」那种看着像通过的假象。
import { vi } from "vitest";
// 只用类型（type-only import 会被擦除），保证假目录树和真 DirEntry 形状对得上
import type { DirEntry } from "@/lib/ipc-fs";

type IpcHandler = (args?: Record<string, unknown>) => unknown;

export interface IpcCall {
  cmd: string;
  args?: Record<string, unknown>;
}

const handlers = new Map<string, IpcHandler>();
const eventHandlers = new Map<string, Set<TestEventHandler>>();

export const ipcCalls: IpcCall[] = [];

export function setIpcHandler(cmd: string, handler: IpcHandler): void {
  handlers.set(cmd, handler);
}

export function setIpcHandlers(map: Record<string, IpcHandler>): void {
  for (const [cmd, handler] of Object.entries(map)) handlers.set(cmd, handler);
}

/** 某个命令的全部调用（含参数），比断言 mock 调用次数更贴近「真的带对了参数吗」 */
export function callsFor(cmd: string): IpcCall[] {
  return ipcCalls.filter((c) => c.cmd === cmd);
}

export const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  ipcCalls.push({ cmd, args });
  const handler = handlers.get(cmd);
  if (!handler) throw new Error(`tauri-mock：命令 "${cmd}" 没有注册返回值`);
  return await handler(args);
});

/** 真实现直接解 window.__TAURI_INTERNALS__（core.js:374），jsdom 里必抛，这里原样返回路径 */
export function convertFileSrc(path: string): string {
  return path;
}

export const appDataDir = vi.fn((): Promise<string> => Promise.resolve("/mock/app-data"));
/** 路径口径与真 join 一致：反斜杠统一成正斜杠，接缝处不重复分隔符 */
export const join = vi.fn((...parts: string[]): Promise<string> => {
  const [base = "", ...rest] = parts.map((p) => p.replace(/\\/g, "/"));
  const segs = [base.replace(/\/+$/, ""), ...rest.map((p) => p.replace(/^\/+|\/+$/g, ""))].filter(Boolean);
  return Promise.resolve(segs.join("/"));
});

/** Channel 替身：真构造即向 Tauri 注册回调，测试改为把实例记下来，由用例主动投喂消息 */
export class MockChannel<T> {
  static seq = 0;
  id: string;
  onmessage?: (message: T) => void;

  constructor() {
    this.id = `mock-channel-${++MockChannel.seq}`;
    channels.push(this);
  }

  /** 模拟 Rust 侧回调一次 */
  deliver(message: T): void {
    this.onmessage?.(message);
  }
}

/** 建过的 Channel 实例；取用请走 lastChannel<T>()，这里不带类型以免泛型互斥 */
export const channels: unknown[] = [];

export function lastChannel<T>(): MockChannel<T> | undefined {
  return channels[channels.length - 1] as MockChannel<T> | undefined;
}

type TestEventHandler = (event: { payload: unknown }) => void;

export const listen = vi.fn((event: string, handler: TestEventHandler): Promise<() => void> => {
  const set = eventHandlers.get(event) ?? new Set<TestEventHandler>();
  set.add(handler);
  eventHandlers.set(event, set);
  return Promise.resolve(() => {
    set.delete(handler);
  });
});

/** 触发一个事件，返回收到消息的监听器数量（0 说明压根没人注册过这个事件） */
export function emitMockEvent(event: string, payload: unknown = null): number {
  const set = eventHandlers.get(event);
  if (!set) return 0;
  for (const handler of [...set]) handler({ payload });
  return set.size;
}

export function listenerCount(event: string): number {
  return eventHandlers.get(event)?.size ?? 0;
}

/** 每个用例的 beforeEach 调一次：命令注册、调用记录、事件监听、Channel、对话框、假目录树与系统侧替身全部归零 */
export function resetIpcMock(): void {
  handlers.clear();
  ipcCalls.length = 0;
  eventHandlers.clear();
  channels.length = 0;
  dialogCalls.length = 0;
  openQueue.length = 0;
  saveQueue.length = 0;
  dirs.clear();
  files.clear();
  fsWrites.length = 0;
  closeRequests.length = 0;
  closeHandler = null;
  appVersion = "0.0.0-test";
  openedUrls.length = 0;
  openUrlFailure = null;
  updateQueue.length = 0;
  installedUpdates.length = 0;
  deepLinkStartupUrls.length = 0;
  deepLinkHandler = null;
  deepLinkGetCurrentFailure = null;
  invoke.mockClear();
  appDataDir.mockClear();
  join.mockClear();
  listen.mockClear();
  open.mockClear();
  save.mockClear();
  readDir.mockClear();
  readTextFile.mockClear();
  writeTextFile.mockClear();
  getCurrentWindow.mockClear();
  onCloseRequested.mockClear();
  windowDestroy.mockClear();
  getVersion.mockClear();
  openUrl.mockClear();
  check.mockClear();
  relaunch.mockClear();
  deepLinkGetCurrent.mockClear();
  deepLinkOnOpenUrl.mockClear();
  loadDeepLink.mockClear();
}

/** 交给 vi.mock 的模块形状：与 @/lib/ipc-core 的导出一一对应 */
export function ipcCoreMock() {
  return { invoke, convertFileSrc, Channel: MockChannel, appDataDir, join };
}

/** 交给 vi.mock 的模块形状：与 @/lib/ipc-events 的导出一一对应 */
export function ipcEventsMock() {
  return { listen };
}

// 对话框侧：没排队结果就当「用户按了取消」（真机返回 null），这比抛错好写用例。
export interface DialogCall {
  kind: "open" | "save";
  options?: Record<string, unknown>;
}

export const dialogCalls: DialogCall[] = [];
const openQueue: (string | string[] | null)[] = [];
const saveQueue: (string | null)[] = [];

export function queueOpenDialog(result: string | string[] | null): void {
  openQueue.push(result);
}

export function queueSaveDialog(result: string | null): void {
  saveQueue.push(result);
}

export const open = vi.fn((options?: Record<string, unknown>): Promise<string | string[] | null> => {
  dialogCalls.push({ kind: "open", options });
  return Promise.resolve(openQueue.shift() ?? null);
});

export const save = vi.fn((options?: Record<string, unknown>): Promise<string | null> => {
  dialogCalls.push({ kind: "save", options });
  return Promise.resolve(saveQueue.shift() ?? null);
});

export function ipcDialogMock() {
  return { open, save };
}

// 文件系统侧：用登记好的假目录树喂 readDir/readTextFile，writeTextFile 只记录不落盘。
interface FsDirEntryLike {
  name: string;
  isDirectory?: boolean;
  isFile?: boolean;
}

const dirs = new Map<string, DirEntry[]>();
const files = new Map<string, string>();
export const fsWrites: { path: string; contents: string }[] = [];

/** 路径口径与 join 替身一致（反斜杠转正斜杠），登记与查询才不会错开 */
function fsKey(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 登记一个目录的内容；未登记的目录被读到时抛错，免得组件对着空列表以为扫描通过 */
export function setFsDir(dir: string, entries: FsDirEntryLike[]): void {
  dirs.set(
    fsKey(dir),
    entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory ?? false,
      isFile: e.isFile ?? !(e.isDirectory ?? false),
      isSymlink: false,
    })),
  );
}

export function setFsFile(path: string, text: string): void {
  files.set(fsKey(path), text);
}

export const readDir = vi.fn((path: string): Promise<DirEntry[]> => {
  const hit = dirs.get(fsKey(path));
  if (!hit) return Promise.reject(new Error(`tauri-mock：目录 "${path}" 没有登记，用 setFsDir 先登记`));
  return Promise.resolve(hit);
});

export const readTextFile = vi.fn((path: string): Promise<string> => {
  const hit = files.get(fsKey(path));
  if (hit === undefined) return Promise.reject(new Error(`tauri-mock：文件 "${path}" 没有登记，用 setFsFile 先登记`));
  return Promise.resolve(hit);
});

export const writeTextFile = vi.fn((path: string, contents: string): Promise<void> => {
  fsWrites.push({ path: fsKey(path), contents });
  return Promise.resolve();
});

export function ipcFsMock() {
  return { readDir, readTextFile, writeTextFile };
}

// 系统集成侧（@/lib/ipc-shell）：窗口生命周期、版本号、系统默认程序、更新与重启、深链。
//
// 这一侧的替身按「用户动作」开口：requestWindowClose() 相当于点窗口关闭按钮，
// emitDeepLinkUrl() 相当于在外部浏览器里点了一个 tsflowy:// 链接。

type CloseHandler = (event: { preventDefault: () => void }) => void | Promise<void>;

let closeHandler: CloseHandler | null = null;
/** 每次「请求关窗」的裁决结果：调用方有没有拦住这次关闭 */
export const closeRequests: { prevented: boolean }[] = [];
/** 窗口真正被销毁的次数（App.tsx 落盘成功后才走到这一步） */
export const windowDestroy = vi.fn((): Promise<void> => Promise.resolve());

export const onCloseRequested = vi.fn((handler: CloseHandler): Promise<() => void> => {
  closeHandler = handler;
  return Promise.resolve(() => {
    closeHandler = null;
  });
});

export const getCurrentWindow = vi.fn(
  (): { onCloseRequested: typeof onCloseRequested; destroy: typeof windowDestroy } => ({
    onCloseRequested,
    destroy: windowDestroy,
  }),
);

/** 模拟用户点关闭按钮：返回有没有注册过关窗处理器（没注册 = 处理器压根没接上） */
export async function requestWindowClose(): Promise<boolean> {
  const record = { prevented: false };
  closeRequests.push(record);
  if (!closeHandler) return false;
  await closeHandler({
    preventDefault: () => {
      record.prevented = true;
    },
  });
  return true;
}

let appVersion = "0.0.0-test";

/** 版本号替身默认 0.0.0-test；设置页那种「读到的是安装包版本」的用例自己改 */
export function setAppVersion(version: string): void {
  appVersion = version;
}

export const getVersion = vi.fn((): Promise<string> => Promise.resolve(appVersion));

/** 交给系统默认程序打开过的地址（含失败的尝试，点没点是业务事实，成没成看 openUrl 的 reject） */
export const openedUrls: string[] = [];
let openUrlFailure: string | null = null;

/** 让下一次 openUrl 失败，用于覆盖调用方的 catch 分支（真机是系统拒绝拉起） */
export function failNextOpenUrl(message = "系统拒绝打开该地址"): void {
  openUrlFailure = message;
}

export const openUrl = vi.fn((url: string | URL): Promise<void> => {
  openedUrls.push(String(url));
  if (openUrlFailure) {
    const message = openUrlFailure;
    openUrlFailure = null;
    return Promise.reject(new Error(message));
  }
  return Promise.resolve();
});

/** 排队一次的「检查更新」结果；传 null 表示已是最新，queueUpdateCheckFailure 表示更新源不可达 */
const updateQueue: (() => MockUpdate | null)[] = [];
export interface MockUpdateRecord {
  version: string;
  /** 装到第几步了（downloadAndInstall 的进度回调按真插件的事件名记账） */
  events: string[];
  installed: boolean;
}

/** 被真的走完 downloadAndInstall 的更新 */
export const installedUpdates: MockUpdateRecord[] = [];

export class MockUpdate {
  readonly version: string;
  readonly currentVersion = appVersion;
  readonly record: MockUpdateRecord;

  constructor(version: string) {
    this.version = version;
    this.record = { version, events: [], installed: false };
  }

  downloadAndInstall(onEvent?: (event: { event: string }) => void): Promise<void> {
    onEvent?.({ event: "Finished" });
    this.record.events.push("Finished");
    this.record.installed = true;
    installedUpdates.push(this.record);
    return Promise.resolve();
  }
}

export function queueUpdateCheck(version: string | null): void {
  updateQueue.push(() => (version === null ? null : new MockUpdate(version)));
}

export function queueUpdateCheckFailure(message = "更新源不可达"): void {
  updateQueue.push(() => {
    throw new Error(message);
  });
}

export const check = vi.fn((): Promise<MockUpdate | null> => {
  const next = updateQueue.shift();
  if (!next) return Promise.reject(new Error("tauri-mock：check() 没有排队结果，用 queueUpdateCheck 先登记"));
  try {
    return Promise.resolve(next());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
});

export const relaunch = vi.fn((): Promise<void> => Promise.resolve());

// 深链：冷启动 URL 排队给 getCurrent()，热启动由 emitDeepLinkUrl() 投喂 onOpenUrl 的处理器。
const deepLinkStartupUrls: (string[] | null)[] = [];
let deepLinkHandler: ((urls: string[]) => void) | null = null;
let deepLinkGetCurrentFailure: string | null = null;

export function queueDeepLinkStartup(urls: string[] | null): void {
  deepLinkStartupUrls.push(urls);
}

/** 让下一次 getCurrent() 失败（覆盖 deep-link.ts 里那条 .catch 只记日志的分支） */
export function failDeepLinkGetCurrent(message = "argv 解析失败"): void {
  deepLinkGetCurrentFailure = message;
}

export const deepLinkGetCurrent = vi.fn((): Promise<string[] | null> => {
  if (deepLinkGetCurrentFailure) {
    const message = deepLinkGetCurrentFailure;
    deepLinkGetCurrentFailure = null;
    return Promise.reject(new Error(message));
  }
  return Promise.resolve(deepLinkStartupUrls.shift() ?? null);
});

export const deepLinkOnOpenUrl = vi.fn((handler: (urls: string[]) => void): Promise<() => void> => {
  deepLinkHandler = handler;
  return Promise.resolve(() => {
    deepLinkHandler = null;
  });
});

/** 模拟外部浏览器点了一个 tsflowy:// 链接（应用已在跑）；返回有没有处理器在听 */
export function emitDeepLinkUrl(...urls: string[]): boolean {
  if (!deepLinkHandler) return false;
  deepLinkHandler(urls);
  return true;
}

export function deepLinkListenerAttached(): boolean {
  return deepLinkHandler !== null;
}

/** 替身保持懒加载口径：调用方 await 到的就是 getCurrent/onOpenUrl */
export const loadDeepLink = vi.fn(
  (): Promise<{ getCurrent: typeof deepLinkGetCurrent; onOpenUrl: typeof deepLinkOnOpenUrl }> =>
    Promise.resolve({ getCurrent: deepLinkGetCurrent, onOpenUrl: deepLinkOnOpenUrl }),
);

/** 交给 vi.mock 的模块形状：与 @/lib/ipc-shell 的导出一一对应 */
export function ipcShellMock() {
  return { getCurrentWindow, getVersion, openUrl, check, relaunch, loadDeepLink };
}
