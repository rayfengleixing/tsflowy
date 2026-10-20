import { invoke } from "@/lib/invoke";
import { logger } from "./logger";

// 偏好镜像：把影响行为的 localStorage 键复制一份进 config.json。
//
// 为什么需要：localStorage 归 WebView 自己的用户数据目录，不在应用数据目录里，
// 所以备份包（data.db + assets + config.json）压根不含它。换机或重装后用户会发现
// 自动同步静静关着、快捷键和主题全没了 —— 而 config.json 是进备份的，存一份就跟着走。
//
// 回填必须发生在任何 store 求值之前（它们在模块初始化时同步读 localStorage），
// 调用点见 main.tsx；写入则走定时 + 页面隐藏时冲刷，不去改写各处 localStorage 调用点。

/** 只镜像小而稳的偏好键：AI 会话正文已有 SQLite 正本且体积不可控，不进这个名单 */
const MIRRORED_KEYS = [
  "tsflowy:auto-sync",
  "tsflowy:daily-notes",
  "tsflowy:update-check",
  "tsflowy:crash-restart",
  "tsflowy:import-fetch-remote",
  "tsflowy-shortcuts",
  "tsflowy-theme",
  "tsflowy-theme-preset",
  "tsflowy-accent",
  "tsflowy-lang",
  "tsflowy-font",
  "tsflowy-font-size",
  "tsflowy-line-height",
  "tsflowy-editor-width",
  "tsflowy:sidebar-width",
  "tsflowy:ui:sidebar_tab",
  "tsflowy-ai-panel-width",
  "tsflowy:editor-readonly",
  "tsflowy:editor-typewriter",
  // 搜索历史最多 8 条查询（lib/search-history.ts 的 MAX），小且稳定，跟着备份走
  "tsflowy:search-history",
  // 「这个新版本已经提示过」：不镜像的话换机后同一个已看过的更新会再弹一次
  "tsflowy:update-notified-version",
];

/** 回填等不到 IPC 时的上限：超了就照常渲染，偏好丢一次启动好过白屏 */
const HYDRATE_TIMEOUT_MS = 1500;
/** 冲刷周期：偏好改动很少，最坏丢 30 秒内的一个开关状态 */
const FLUSH_INTERVAL_MS = 30_000;

function readSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MIRRORED_KEYS) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) out[key] = v;
    } catch {
      // localStorage 被禁用（无痕模式等）：这个键跳过，其余照常
    }
  }
  return out;
}

let lastFlushed = "";

async function flush(): Promise<void> {
  const snapshot = readSnapshot();
  const json = JSON.stringify(snapshot);
  // 定时冲刷每 30 秒跑一次，值没变就不该反复写盘
  if (json === lastFlushed) return;
  try {
    await invoke("set_prefs", { prefs: snapshot });
    lastFlushed = json;
  } catch (e) {
    logger.warn("prefs", "mirror write failed", e);
  }
}

/**
 * 应用启动时调用一次：把备份里带回来的镜像写回本机缺失的 localStorage 键，
 * 之后由定时与页面隐藏事件负责冲刷。
 */
export async function hydratePrefs(): Promise<void> {
  // 值类型按 unknown 处理：config.json 可能被手改过，回填前逐个再验一遍
  let stored: Record<string, unknown> | undefined;
  try {
    stored = await Promise.race([
      invoke<Record<string, unknown> | undefined>("get_prefs"),
      new Promise<Record<string, unknown> | undefined>((resolve) =>
        setTimeout(() => resolve(undefined), HYDRATE_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    logger.warn("prefs", "read mirror failed", e);
  }
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (!MIRRORED_KEYS.includes(key) || typeof value !== "string") continue;
    try {
      // 本机已有则以本机为准：镜像只是换机兜底，不该覆盖这台机器上的最新改动
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    } catch {
      /* 写入失败时这台机器继续用默认值 */
    }
  }
  lastFlushed = JSON.stringify(readSnapshot());

  window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}
