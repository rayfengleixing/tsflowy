// 原生 IPC 边界的唯一引入口。业务代码请继续用 @/lib/invoke（要上报本机写入的那一层）。
//
// 本模块只做转发，且刻意不 import 任何应用层模块 —— auto-sync 与 client-log 需要不经拦截的
// 原始 invoke，而这两条直连各自有回环要避：
//   · auto-sync 被 @/lib/invoke import（markLocalWrite），反向导入即成环；
//   · client-log 被 logger import，而 auto-sync import logger，走 @/lib/invoke 会绕回 auto-sync。
// 有了这一层，它们拿到的仍是同一个 raw 通道，但 @tauri-apps/api 的引用面全仓收敛到这一个文件。
//
// 为什么不 monkey-patch window.__TAURI_INTERNALS__.invoke：Tauri 2 把该属性定义为只读且不可
// 重定义（writable:false, configurable:false），赋值会在入口模块加载阶段抛 TypeError，
// 导致整个 bundle 中断、React 从未挂载（白屏）。
//
// 测试替身见 src/test/tauri-mock.ts：vi.mock("@/lib/ipc/ipc-core", …) 一处即可拦下命令与路径调用。
export { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
// path 模块的函数内部就是 invoke（node_modules/@tauri-apps/api/path.js:1），与 core 同一根管子，
// 所以 jsdom 里 appDataDir()/join() 同样会炸，必须一起收口才谈得上「一个模块 mock 到底」。
export { appDataDir, join } from "@tauri-apps/api/path";
