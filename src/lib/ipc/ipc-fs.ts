// 前端侧直接读写文件系统的边界（@tauri-apps/plugin-fs）唯一引入口。
//
// 只覆盖这三处仍在用的函数：目录列举、文本读、文本写。路径由 Rust 侧 scope 授权，
// 所以这层没有额外校验，收口纯粹为了可测：vi.mock("@/lib/ipc/ipc-fs", …) 给一棵假目录树，
// 递归扫描与往返编码就能在 jsdom / node 里跑。
export { readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
export type { DirEntry } from "@tauri-apps/plugin-fs";
