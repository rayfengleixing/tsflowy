# TsFlowy 更新日志（CHANGELOG）

版本号唯一权威来源：`src-tauri/tauri.conf.json` 的 `version` 字段（与 `package.json#version` 同步维护，两者必须一致）。

每次 `npm run tauri build` 生成产物：
- NSIS 安装包路径：`src-tauri/target/release/bundle/nsis/`
- 安装包命名：`TsFlowy-{version}-x64-setup.exe`（见 tauri.conf.json `installerPattern`）
- 配套发布说明：`docs/releases/RELEASE_NOTES_v{version}.md`

---

## [0.1.0] — 2026-09-04

详细说明见 [docs/releases/RELEASE_NOTES_v0.1.0.md](docs/releases/RELEASE_NOTES_v0.1.0.md)。
