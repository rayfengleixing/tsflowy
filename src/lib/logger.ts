/**
 * 统一前端日志门面（Phase 4 优化 · P2#1）。
 *
 * 设计：
 * · 生产构建下自动降级：warn/error 保留；debug/trace/log 级直接丢弃（避免 63 处 console.error/warn 裸写
 *   在 release 中依然刷用户控制台）。
 * · 可切换 `logger.setLevel('debug')` 手动开到 debug。
 * · 每一行实际打印出来的日志同时经 client-log 转写本机日志文件（设置页可一键导出诊断包），
 *   所以新增日志只需走本入口，不要再用 console.*。
 */

import { formatLogArgs, pushClientLog } from "./client-log";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "off";

const LEVEL: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  off: 5,
};

let currentLevel: LogLevel = import.meta.env.PROD ? "warn" : "debug";

export function setLevel(l: LogLevel) {
  currentLevel = l;
}

export function getLevel(): LogLevel {
  return currentLevel;
}

const isOn = (l: LogLevel) => LEVEL[l] >= LEVEL[currentLevel];

const buildMessage = (ctx: string | undefined, args: unknown[]): unknown[] => {
  if (ctx) return [`[${ctx}]`, ...args];
  return args;
};

/** 控制台之外再落一份到本机日志文件；error 级不等批量窗口，崩溃前的最后一条最值得留 */
const toFile = (level: "trace" | "debug" | "info" | "warn" | "error", ctx: string | undefined, args: unknown[]) => {
  pushClientLog(level, formatLogArgs(ctx, args), level === "error");
};

export const logger = {
  trace: (...args: unknown[]) => {
    if (!isOn("trace")) return;
    console.trace(...buildMessage(undefined, args));
    toFile("trace", undefined, args);
  },
  debug: (ctx?: string, ...args: unknown[]) => {
    if (!isOn("debug")) return;
    console.debug(...buildMessage(ctx, args));
    toFile("debug", ctx, args);
  },
  info: (ctx?: string, ...args: unknown[]) => {
    if (!isOn("info")) return;
    console.info(...buildMessage(ctx, args));
    toFile("info", ctx, args);
  },
  warn: (ctx?: string, ...args: unknown[]) => {
    if (!isOn("warn")) return;
    console.warn(...buildMessage(ctx, args));
    toFile("warn", ctx, args);
  },
  error: (ctx?: string, ...args: unknown[]) => {
    if (!isOn("error")) return;
    console.error(...buildMessage(ctx, args));
    toFile("error", ctx, args);
  },
  /**
   * 便捷写法：logger.catch("load tabs", id)(e) → 错误上下文 + warn 级别（常见模式）。
   * 例：something.catch(logger.catch("xxx failed", extra))。
   */
  catch:
    (ctx: string, ...extra: unknown[]) =>
    (e: unknown) => {
      if (!isOn("warn")) return;
      console.warn(`[${ctx}]`, ...extra, e);
      toFile("warn", ctx, [...extra, e]);
    },
};

// 开发环境下把 logger 挂到全局，便于 F12 手动 setLevel('trace')
declare global {
  interface Window {
    __tsflowy_logger?: typeof logger & { setLevel: typeof setLevel; getLevel: typeof getLevel };
  }
}
if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__tsflowy_logger = Object.assign(
    (..._: unknown[]) => undefined, // stub
    logger,
    { setLevel, getLevel },
  );
}
