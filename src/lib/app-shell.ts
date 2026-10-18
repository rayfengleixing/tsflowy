import { invoke } from "@/lib/invoke";
import { logger } from "./logger";

// 原生壳层（Windows 菜单栏 + 系统托盘）的文案在 Rust 侧，不在 React 树里，
// 前端 i18n 切换碰不到它 —— 只能把当前语言报过去，让壳层按语言重建菜单。
// set_lang 不在 auto-sync 的写命令白名单里，走统一 invoke 入口不会误触发同步。

/** 切换语言时同步原生菜单与托盘；失败只记日志，界面切换不该被系统控件拖住 */
export function syncNativeLang(lang: string): void {
  invoke("set_lang", { lang }).catch((e: unknown) => logger.warn("shell", "native menu refresh failed", e));
}

// ——— 开机自启 ———
// 正本在注册表的 HKCU Run 项里，不在本机任何存储里，所以设置页每次都要现读一遍。
// Rust 侧记录的启动命令在这里回显：装在第二份目录里时用户能一眼看出不对。

export interface AutostartState {
  enabled: boolean;
  command: string;
  /** 注册表读不到（组策略禁用等）：界面显示「不可用」而不是假的「已关闭」 */
  unavailable: boolean;
}

export function getAutostartState(): Promise<AutostartState> {
  return invoke<AutostartState>("get_autostart");
}

export function setAutostart(on: boolean): Promise<void> {
  return invoke("set_autostart", { enabled: on });
}

// ——— 崩溃自动重启 ———
// 开关是前端偏好（进镜像跟备份走），Rust 的 panic 钩子读镜像值决定是否重新拉起自身。
// 最坏滞后一个冲刷周期（30 秒），所以文案写明「下次崩溃前生效」。

const CRASH_RESTART_KEY = "tsflowy:crash-restart";

export function crashRestartEnabled(): boolean {
  try {
    return localStorage.getItem(CRASH_RESTART_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCrashRestartEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(CRASH_RESTART_KEY, "1");
    else localStorage.removeItem(CRASH_RESTART_KEY);
  } catch {
    /* localStorage 被禁用时这台机器保持默认（关） */
  }
}

/** 本次进程是不是崩溃后自动拉起来的（>0 表示第几轮）；前端据此提示一次 */
export function crashRestartRound(): Promise<number> {
  return invoke<number>("crash_restart_round").catch(() => 0);
}
