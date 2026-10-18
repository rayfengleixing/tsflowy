import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { hydratePrefs } from "@/lib/prefs-mirror";

const root = document.getElementById("root");
if (!root) throw new Error("未找到 #root 挂载点");

// App 及其 store 模块在求值时就同步读 localStorage，所以镜像回填必须早于这一次 import()；
// 静态 import 会被提升到最前面，达不到这个顺序。hydratePrefs 内部自带超时，IPC 卡住也只是少恢复一次偏好。
void (async () => {
  await hydratePrefs();
  const App = (await import("./App")).default;
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
