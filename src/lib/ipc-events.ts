// Rust → 前端事件边界的唯一引入口。
//
// 业务代码不从这里取 listen，而是取 sync-events.ts 那样的语义封装（订阅进度帧、是否要重载窗口）；
// 这层的价值全在测试：vi.mock("@/lib/ipc-events", …) 一处就能喂事件，
// 不必在每个用例里重复 mock @tauri-apps/api/event，也不必真起 Tauri。
export { listen } from "@tauri-apps/api/event";
export type { UnlistenFn } from "@tauri-apps/api/event";
