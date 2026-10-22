// 系统文件/文件夹对话框边界的唯一引入口。
//
// 这两个函数不写数据，只是向用户要一个路径；真机弹原生窗，jsdom 里必然拿不到结果。
// 收在一处后，组件测试用 vi.mock("@/lib/ipc-dialog", …) 就能把「用户选了哪个目录 / 取消了」
// 当成输入喂进来（替身见 src/test/tauri-mock.ts）。
export { open, save } from "@tauri-apps/plugin-dialog";
