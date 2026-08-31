# AppFlowy TS

用 **Tauri 2 + React 19 + TypeScript + TipTap + SQLite** 从零重写的 Windows 桌面笔记/知识管理应用（功能对标 AppFlowy 桌面版）。

> **唯一权威项目说明**：`AppFlowy-TS-项目说明书.md`（位于项目上级目录，与本仓库同级）。所有功能范围、数据模型、UI 规范、里程碑与验收标准均以该文档为准。任何与代码行为的偏差，以"修改该文档 + 同步代码"为唯一更新路径。

## 环境要求

| 软件 | 版本要求 |
|---|---|
| Node.js | ≥ 20 LTS |
| npm | ≥ 10 |
| Rust (rustup) | stable ≥ 1.77，host 为 `x86_64-pc-windows-msvc` |
| MSVC Build Tools | 最新（勾选"使用 C++ 的桌面开发"） |
| WebView2 Runtime | Win10/11 自带 |

## 开发

```powershell
npm install
npm run tauri dev
```

- 数据目录（运行时自动创建）：`%APPDATA%\com.appflowy-ts.app\`，内含 `appflowy.db`（SQLite）与 `assets/`。
- 首次编译需 5-10 分钟（Rust 依赖多），之后增量编译秒级。
- SQL 迁移文件在 `migrations/`，按序号递增，禁止修改已应用的迁移。

## 里程碑

当前进度：**M2（工作区壳）已完成**。验收记录与后续里程碑见项目说明书第 10 章。
- M1（骨架）：Tauri 2 + SQLite 迁移 + 冒烟测试 ✅
- M2（工作区壳）：侧边栏（空间切换/页面树/新建/收藏）、标签栏、四布局占位页、拖拽排序、回收站（恢复/彻底删除/清空）、§6.5 视觉 token ✅

## 测试

```powershell
npm test   # Vitest：树操作纯函数（buildTree/computeRenumber/dropTarget 等）
```
