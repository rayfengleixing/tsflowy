// IPC 统一入口（同步自动化的咽喉点）。
//
// 为什么不用 monkey-patch window.__TAURI_INTERNALS__.invoke：
// Tauri 2 把该属性定义为只读且不可重定义（writable:false, configurable:false），
// 直接赋值会在入口模块加载阶段抛 TypeError，导致整个 bundle 中断、React 从未挂载（白屏）。
// 因此改为在应用层包一层：所有业务模块从这里导入 invoke，包装函数在转发给真实 IPC 后
// 通知 auto-sync「这是一次本机写入」。auto-sync 自身仍直接用 @tauri-apps/api/core
// （run_sync 不属于写命令，无需拦截，同时避免与本模块形成循环依赖）。
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { markLocalWrite } from "./auto-sync";

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const p = rawInvoke<T>(cmd, args);
  markLocalWrite(cmd);
  return p;
}
