# TsFlowy v0.1.0 发布说明

> 生成时间：2026-09-04
> 对应安装包：`src-tauri/target/release/bundle/nsis/TsFlowy-0.1.0-x64-setup.exe`

## 📦 安装包

Windows x64 NSIS 安装包：**`TsFlowy-0.1.0-x64-setup.exe`**（约 5.35 MB）

## ✨ 新增功能

### P0 · 数据库与性能
- SQLite WAL 模式 + `synchronous=NORMAL` + busy_timeout=5000ms + cache_size=-10000（PRAGMA 性能优化）
- 006 复合索引：mentions 双向查询、workspace views/favorites/trash 三视角显著加速
- Tauri capabilities 最小化：fs 权限收窄至 `allow-appdata-write-recursive` 等 4 条
- `runInTransaction` 事务工具：moveView/renumber 等批量重排操作具备原子性

### P1 · 前端体验
- **TabBar 状态持久化**：tabs / 当前 view 写入 `app_settings`，重启原样恢复（含 debounce）
- **19 组件 Zustand 选择器**：`useShallow`/原子选择器 替换对象字面量，避开 React 19 useSyncExternalStore 缓存告警
- **TypeScript strict**：floating-menu / block-drag 等 4 处 `any` 全部移除
- **ESLint + Prettier**：0 errors，229 warnings 留待后续渐进清理
- **Husky + lint-staged**：pre-commit 自动 lint 修复
- **logger 门面**：`logger.trace/debug/info/warn/error/catch`，生产默认 warn 级别，`console.*` 裸写清零

### P2 · 性能与健壮性
- **Document save mailbox**：快速编辑合并成单次 DB 写入，避免频繁 IO
- **mentions backfillIfEmpty 分批**：8 docs/tick + 10ms sleep，大库启动不卡 UI
- **fallback 反链扫描节流**：30min 全局窗口，避免打开每篇文档都全库扫描
- **moveView / renumber 事务化**：崩溃不会出现父子/position 半刷不一致

### 新接入的功能（本轮补齐）
1. **首 Heading 锁定文档名**：`FirstHeadingLock` TipTap 扩展 — 文档第一 H1 文本自动同步到 `view.name`，避免 TabBar/顶栏显示"未命名"
2. **SubPagePicker**：slash 菜单 + 命令面板插入"子页面引用"块，点击跳转到目标页，显示子页标题
3. **Sidebar 最近 / 收藏 Tab**：
   - 最近：按 `views.visited_at` 倒序，最多 30 条，`openView` 时自动 `touchVisited`
   - 收藏：点击星标 toggle，视图 `is_favorite` 写数据库
4. **Ctrl+Shift+F** 全局搜索（Settings 页已列出快捷键，App.tsx 统一注册）
5. **数据库字段类型恢复**：`FIELD_TYPES` 补齐 `relation / created_at / last_edited_at`；`READONLY_FIELD_TYPES` 标记时间戳只读

### UI 精简
- **Breadcrumb**：只显示祖先链，当前页本身不再重复展示（避免 TabBar/顶栏/面包屑三处同显）
- **顶栏图标**：EditorPage/GridView/BoardView/CalendarView 4 处顶栏删除了与 TabBar 重复的 `viewIcon`

## 🐛 修复

- React 19 DevMode 死循环（`getSnapshot should be cached` / `Maximum update depth exceeded`）：根因是 zustand 对象字面量 selector 与 store 外部重复 emit；改为「4 条原子 selector + store 内部 ready 兜底 + useShallow」统一治理
- tauri.conf.json 非法字段清理：`app.updater`（与用户声明"不需要自动更新"一致）、NSIS `allowDowngrades` 等 4 条当前 CLI 不识别字段、`sidebarImage/headerImage` 空字符串
- `capabilities/default.json` 4 条 fs 权限名拼写修正为 tauri-build 暴露的确切名称

## 🔧 构建 / CI
- GitHub Actions Windows CI：`tsc → vitest → cargo check` 三阶段
- NSIS 打包：简体中文单语言，`TsFlowy-{version}-x64-setup.exe` 稳定命名模式（见 tauri.conf.json `installerPattern`）

## ✅ 验证矩阵

| 命令 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `vitest run` | 97/97 passed |
| `npm run lint` | 0 errors / 229 warnings |
| `cargo check` | 0 warnings / 0 errors |
| `tauri build` | exit 0，NSIS 安装包生成成功 |

## ⚠️ 待后续版本补齐（尚未接入，另行确认）

- 页面属性 chips（`page_properties` 表 + PageProperties 组件，需确认是否要作为文档顶部栏）
- 数据库附件字段类型（`attachment`，Rust save_asset 已存在，字段创建 UI 需挂接）
- 模板视图 / Sidebar 模板入口（本轮按你的要求跳过）
