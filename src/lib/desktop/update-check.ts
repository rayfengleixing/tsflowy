import { check } from "@/lib/ipc/ipc-shell";
import { toast } from "sonner";
import { appSetRoute } from "@/lib/app-context";
import { t } from "@/lib/i18n";
import { logger } from "../logger";

// 自动检查更新：设置页那个按钮只有被点时才联网，而桌面应用会一直开着，等不到第二次点击。
// 这里只负责「问一遍 + 说一句」，下载与安装仍然手动 —— 后台定时器不该有权静默换掉二进制。

const ENABLE_KEY = "tsflowy:update-check";
/** 已经提醒过的版本：同一个版本不必每次启动再唠叨一遍 */
const NOTIFIED_KEY = "tsflowy:update-notified-version";
/** 冷启动延迟：首屏渲染、自动同步、数据库巡检都排在前面，网络检查不跟它们抢 */
const STARTUP_DELAY_MS = 20_000;
/** 复查周期：常驻应用一天一次足够，再多就是给更新源添负载 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type AutoCheckOutcome = "disabled" | "latest" | "already-notified" | "notified" | "failed";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function autoUpdateCheckEnabled(): boolean {
  return read(ENABLE_KEY) === "1";
}

/** 开关本身走 localStorage（并由偏好镜像抄进 config.json 进备份），改动即刻生效于本会话 */
export function setAutoUpdateCheckEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLE_KEY, "1");
    else {
      localStorage.removeItem(ENABLE_KEY);
      // 关掉顺便清掉「已提醒」记录：重新打开时同一个版本还能再提示一次
      localStorage.removeItem(NOTIFIED_KEY);
    }
  } catch {
    /* localStorage 不可用时本次会话照旧生效，只是下次启动回到默认（关） */
  }
  if (on) startUpdateChecks();
  else stopUpdateChecks();
}

let startupTimer = 0;
let intervalTimer = 0;
let lastCheckAt = 0;
let foregroundBound = false;

/**
 * 跑一次后台检查。返回结论供调用方与测试判断走了哪条分支：
 * 出错（离线、更新源不可达、开发构建没配更新源）静默记日志，只有真有新版本才出声。
 */
export async function autoCheckOnce(): Promise<AutoCheckOutcome> {
  if (!autoUpdateCheckEnabled()) return "disabled";
  lastCheckAt = Date.now();
  let version: string;
  try {
    const update = await check();
    if (!update) return "latest";
    version = update.version;
  } catch (e) {
    logger.warn("update", "auto update check failed (offline or feed unreachable)", e);
    return "failed";
  }
  try {
    if (localStorage.getItem(NOTIFIED_KEY) === version) return "already-notified";
    localStorage.setItem(NOTIFIED_KEY, version);
  } catch {
    /* 存不下就少一层防唠叨，提示照发 */
  }
  toast.info(t("settings.updateFound", { version }), {
    duration: 0,
    action: { label: t("settings.updateGoSettings"), onClick: () => appSetRoute("settings") },
  });
  return "notified";
}

/** 休眠/最小化会冻结 setInterval 且恢复后不补跑过期的一拍：回前台时自己看一眼是否超周期（同 auto-sync） */
function onForeground() {
  if (document.visibilityState !== "visible") return;
  if (!autoUpdateCheckEnabled()) return;
  if (Date.now() - lastCheckAt >= CHECK_INTERVAL_MS) void autoCheckOnce();
}

/** 启动排程（幂等）：偏好为关时什么都不做 */
export function startUpdateChecks(): void {
  if (!autoUpdateCheckEnabled() || startupTimer || intervalTimer) return;
  startupTimer = window.setTimeout(() => void autoCheckOnce(), STARTUP_DELAY_MS);
  intervalTimer = window.setInterval(() => void autoCheckOnce(), CHECK_INTERVAL_MS);
  if (!foregroundBound) {
    document.addEventListener("visibilitychange", onForeground);
    foregroundBound = true;
  }
}

export function stopUpdateChecks(): void {
  if (startupTimer) window.clearTimeout(startupTimer);
  if (intervalTimer) window.clearInterval(intervalTimer);
  startupTimer = 0;
  intervalTimer = 0;
}
