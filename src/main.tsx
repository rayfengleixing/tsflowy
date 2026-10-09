import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { markLocalWrite } from "@/lib/auto-sync";

// 单一咽喉点：包装 Tauri IPC 入口，识别写命令以驱动"写入后自动同步"的防抖定时器。
// 各写入口（编辑器/表格/视图配置…）无需任何改动。
type InvokeFn = (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
const internals = window as unknown as { __TAURI_INTERNALS__?: { invoke: InvokeFn } };
const target = internals.__TAURI_INTERNALS__;
if (target && typeof target.invoke === "function") {
  const original = target.invoke;
  target.invoke = (cmd, args, options) => {
    const p = original(cmd, args, options);
    markLocalWrite(cmd);
    return p;
  };
}

const root = document.getElementById("root");
if (!root) throw new Error("未找到 #root 挂载点");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
