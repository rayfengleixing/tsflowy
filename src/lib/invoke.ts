// IPC 统一入口（同步自动化的咽喉点）。
//
// 为什么不用 monkey-patch window.__TAURI_INTERNALS__.invoke：
// Tauri 2 把该属性定义为只读且不可重定义（writable:false, configurable:false），
// 直接赋值会在入口模块加载阶段抛 TypeError，导致整个 bundle 中断、React 从未挂载（白屏）。
// 因此改为在应用层包一层：所有业务模块从这里导入 invoke，包装函数在转发给真实 IPC 后
// 通知 auto-sync「这是一次本机写入」。raw 通道在 @/lib/ipc-core（唯一引 @tauri-apps/api 的文件），
// auto-sync 与 client-log 从那里取 —— 它们不经这里拦截，理由是循环 import，见 ipc-core.ts 头注。
import { markLocalWrite } from "./auto-sync";
import { invoke as rawInvoke } from "./ipc-core";

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const p = rawInvoke<T>(cmd, args);
  markLocalWrite(cmd);
  return p;
}
