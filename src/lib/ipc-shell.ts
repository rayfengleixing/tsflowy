// 系统集成边界的唯一引入口：窗口生命周期、应用版本号、交给系统默认程序打开、更新与重启、深链。
//
// 这一层和 @/lib/ipc-core 不同，它不经过 invoke 的「本机写入上报」，但每个函数都要真起 Tauri
// 才有的东西：关窗事件、系统浏览器、更新源。jsdom 里全都拿不到，所以收在一处后
// vi.mock("@/lib/ipc-shell", …) 一个模块就能把「用户点了关窗 / 点了链接 / 有新版本」喂成输入。
// 替身见 src/test/tauri-mock.ts。
//
// 这里只做转发，不夹带任何判定：链接协议白名单在 cell-display.tsx，更新节流在 update-check.ts，
// 关窗前落盘在 App.tsx —— 那些是业务，边界只管通到原生。
export { getCurrentWindow } from "@tauri-apps/api/window";
export { getVersion } from "@tauri-apps/api/app";
export { openUrl } from "@tauri-apps/plugin-opener";
export { check } from "@tauri-apps/plugin-updater";
export { relaunch } from "@tauri-apps/plugin-process";

// 深链保持按需加载：原调用点就是动态 import（不在入口模块求值插件），换成静态 re-export
// 会把它提前到首屏，属行为变更，所以这里包一层把引用面收回来的同时把懒加载原样留住。
export function loadDeepLink(): Promise<typeof import("@tauri-apps/plugin-deep-link")> {
  return import("@tauri-apps/plugin-deep-link");
}
