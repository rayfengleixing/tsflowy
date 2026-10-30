/**
 * 前端日志转写到本机日志文件（Rust 侧 write_client_logs，与 tracing 共用同一份按天切分的文件）。
 *
 * 为什么要这一层：WebView2 的控制台普通用户打不开，而前端恰恰是「点了没反应」这类问题的一线现场。
 * 批量发送：一次重渲染可能连打十几条，逐条走 IPC 会把序列化压在主线程上；错误级别则立刻刷，
 * 崩溃前的最后一条最值得留。失败后整段禁用：日志出口再报错会绕回 logger 自己，形成回环。
 *
 * 走 @/lib/ipc-core 的 raw invoke 而不是 @/lib/invoke：后者 import auto-sync，auto-sync import
 * logger，logger import 本模块 —— 转一圈就回到这里，模块初始化顺序会踩上空窗；
 * 且 write_client_logs 本就不该被算成「本机写入」。
 */
import { invoke as rawInvoke } from "../ipc/ipc-core";

import { registerCloseFlush } from "../close-flush";

export interface ClientLogLine {
  level: string;
  message: string;
}

/** 攒够这么多行马上发（不等定时器） */
const FLUSH_THRESHOLD = 20;
/** 缓冲区上限：错误风暴时丢掉最旧的，别让内存跟着涨 */
const MAX_PENDING = 200;
/** 不满阈值也最多等这么久 */
const FLUSH_DELAY_MS = 3000;

let pending: ClientLogLine[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;
// 没有 Tauri IPC 的地方（浏览器里跑的前端、vitest 的 node 环境）压根没有 write_client_logs
// 这条命令，第一次就该判定为不可用，而不是每条日志都撞一次异常
let disabled = typeof window === "undefined" || !("__TAURI_INTERNALS__" in window);

function cancelTimer() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** 把一条日志的实际参数拼成单行文本（Error 带堆栈，其余尽量结构化） */
export function formatLogArgs(ctx: string | undefined, args: unknown[]): string {
  const parts = args.map(formatOne);
  return ctx ? [`[${ctx}]`, ...parts].join(" ") : parts.join(" ");
}

/** 一个日志参数变成一行文本：字符串原样，Error 带堆栈，其余交给 JSON（不会是 [object Object]） */
function formatOne(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return Array.isArray(value) ? "[Array]" : "[object]";
    }
  }
  // undefined / bigint / symbol / function：JSON 要么拒绝要么给不出有用的东西，报类型名
  return `[${typeof value}]`;
}

async function send(lines: ClientLogLine[]): Promise<void> {
  try {
    await rawInvoke("write_client_logs", { lines });
  } catch {
    // 命令未注册或 IPC 中途不可用：转写这条路就此放弃，控制台照常
    disabled = true;
    cancelTimer();
  }
}

/**
 * 发一批。同一时刻只让一条 IPC 在途：错误风暴时逐条排队会把主线程的活全押给序列化，
 * 后来的行因此继续攒在缓冲里，攒满 MAX_PENDING 就丢最旧的。
 */
function sendNext(): Promise<void> {
  if (sending) return sending;
  if (disabled || pending.length === 0) return Promise.resolve();
  const lines = pending;
  pending = [];
  sending = send(lines).then(() => {
    sending = null;
    if (!disabled && pending.length > 0) return sendNext();
  });
  return sending;
}

/** 把缓冲区里的行全部交给 IPC；关窗前用它兜住还没发出去的最后一批 */
export async function flushClientLogs(): Promise<void> {
  if (sending) await sending;
  if (disabled || pending.length === 0) return;
  await sendNext();
}

/**
 * logger 每打印一行就调这里。
 * @param immediate 错误级别不等批量窗口，下一个微任务就发出去
 */
export function pushClientLog(level: string, message: string, immediate = false): void {
  if (disabled) return;
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push({ level, message });
  if (immediate || pending.length >= FLUSH_THRESHOLD) {
    cancelTimer();
    void sendNext();
    return;
  }
  timer ??= setTimeout(() => {
    timer = null;
    void sendNext();
  }, FLUSH_DELAY_MS);
}

// 关窗时把缓冲区里还没发出去的行交给 IPC（与 UI 状态、编辑器文档同一条落盘通道）
registerCloseFlush(flushClientLogs);
