/**
 * 统一前端日志门面（Phase 4 优化 · P2#1）。
 *
 * 设计：
 * · 生产构建下自动降级：warn/error 保留；debug/trace/log 级直接丢弃（避免 63 处 console.error/warn 裸写
 *   在 release 中依然刷用户控制台）。
 * · 可切换 `logger.setLevel('debug')` 手动开到 debug。
 * · 未来要接「写本地日志文件/上报 Tauri invoke」只需改本文件（所有组件都走 logger 入口）。
 */

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

export const logger = {
  trace: (...args: unknown[]) => {
    if (isOn("trace")) console.trace(...buildMessage(undefined, args));
  },
  debug: (ctx?: string, ...args: unknown[]) => {
    if (isOn("debug")) console.debug(...buildMessage(ctx, args));
  },
  info: (ctx?: string, ...args: unknown[]) => {
    if (isOn("info")) console.info(...buildMessage(ctx, args));
  },
  warn: (ctx?: string, ...args: unknown[]) => {
    if (isOn("warn")) console.warn(...buildMessage(ctx, args));
  },
  error: (ctx?: string, ...args: unknown[]) => {
    if (isOn("error")) console.error(...buildMessage(ctx, args));
  },
  /**
   * 便捷写法：logger.catch("load tabs", id)(e) → 错误上下文 + warn 级别（常见模式）。
   * 例：something.catch(logger.catch("xxx failed", extra))。
   */
  catch: (ctx: string, ...extra: unknown[]) => (e: unknown) => {
    if (isOn("warn")) console.warn(`[${ctx}]`, ...extra, e);
  },
};

// 开发环境下把 logger 挂到全局，便于 F12 手动 setLevel('trace')
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __tsflowy_logger?: typeof logger & { setLevel: typeof setLevel; getLevel: typeof getLevel };
  }
}
if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__tsflowy_logger = Object.assign(
    (..._: unknown[]) => {}, // stub
    logger,
    { setLevel, getLevel },
  );
}
