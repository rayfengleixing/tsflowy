# 更新日志

记录 TsFlowy 的每次实质改动，中文。约定：

- 一批改动一小节，标题写「用户能感觉到的变化」，末尾括号里带提交哈希便于回溯。
- 发版时把「未发布」下的条目归档进对应版本小节（`## v0.8.33` 这样）。
- 打包时这个文件随安装包分发（见 `src-tauri/tauri.conf.json` 的 `bundle.resources`），安装目录下的 `resources/CHANGELOG.md`。
- 更早版本的发布说明在 GitHub Releases 上，与 `latest.json` 的 `notes` 同源。

## 未发布（v0.8.33 之后）

### 工程：绕过统一入口的 IPC 调用收口，组件可以在 jsdom 里测

- 新增 `src/lib/ipc-core.ts`（唯一引 `@tauri-apps/api/core` 与 `api/path` 的文件）和 `src/lib/ipc-events.ts`（唯一引 `api/event` 的文件）：`ai.ts` 的 `Channel`、`assets.ts` 的 `convertFileSrc`/`appDataDir`/`join`、`CsvImportDialog.tsx` 的 `join`、`sync-events.ts` 的 `listen` 全部改从这两个入口导入。业务侧仍走 `@/lib/invoke`，`auto-sync` 与 `client-log` 仍拿不经拦截的 raw 通道（前者与 `invoke.ts` 互引会成环，后者经 `logger` 绕回 `auto-sync`），只是 import 源换成 `ipc-core`。
- 新增 `src/test/tauri-mock.ts`：按命令名注册返回值的 IPC 替身，含事件监听与 `Channel` 投喂；命令没注册直接抛错而不是回 `undefined`，免得组件漏注册被看成「数据正好是空的」。组件测试按需顶掉 `ipc-core` / `ipc-events` / `ipc-dialog` / `ipc-fs` / `ipc-shell` 这几个入口之一即可，不必再逐文件 `vi.mock("@tauri-apps/…")`。
- 新增两组用例：替身本身的行为（命令命中 / 未注册抛错 / 真实 `sync-events` 收帧 / `aiChat` 的 Channel 回调），以及 `SettingsDataDir` 在 jsdom 里真渲染（读命令回填输入框、云盘路径出风险条、点按钮打到 Rust 命令名）。
- 新增第三、第四个入口 `src/lib/ipc-dialog.ts`（唯一引 `@tauri-apps/plugin-dialog`）与 `src/lib/ipc-fs.ts`（唯一引 `@tauri-apps/plugin-fs`）：14 处 `open`/`save`（对话框）与 3 处 `readDir`/`readTextFile`/`writeTextFile`（目录列举与文本读写）改从这两个入口导入，含 `stores/ai.ts`、`GridView.tsx`、`SettingsBackup.tsx` 等。替身补了对应能力：对话框按「排队一次给一个」返回，排空即当用户取消（`null`）；假目录树用 `setFsDir`/`setFsFile` 登记，没登记的目录被读到直接抛错，`writeTextFile` 只记录不落盘。
- 新增用例：`CsvImportDialog` 在 jsdom 里真点一遍「选附件文件夹 → 递归扫描子目录 → 按名匹配」，断言统计数字、`recursive` 参数与回传给导入层的「小写文件名 → 绝对路径」索引；取消对话框那条路径断言不去扫目录。
- 新增第五个入口 `src/lib/ipc-shell.ts`（唯一引 `api/window`、`api/app`、plugin-opener、plugin-updater、plugin-process、plugin-deep-link 的文件）：`App.tsx` 的 `getCurrentWindow`、设置页的 `getVersion`、`Markdown.tsx` 与 `cell-display.tsx` 的 `openUrl`、`SettingsUpdates.tsx` 的 `check`/`relaunch`、`update-check.ts` 的 `check`、`deep-link.ts` 的深链插件共 7 处改从这个入口导入。深链原来是 `await import("plugin-deep-link")`（不在入口模块求值插件），收口后用 `loadDeepLink()` 保住这层懒加载，只换 import 源不改加载时机。至此非测试代码里 `@tauri-apps` 的引用面只剩这五个 `ipc-*` 文件。
- 替身补了系统侧能力：`getCurrentWindow()` 返回能接 `onCloseRequested`/`destroy` 的窗口替身，`requestWindowClose()` 相当于用户点关闭按钮（返回处理器有没有拦住）；`openUrl` 记录每次尝试、`failNextOpenUrl()` 让下一次失败以覆盖调用方的 catch；更新按 `queueUpdateCheck()` 排队，装完记进 `installedUpdates`；深链用 `queueDeepLinkStartup()`（冷启动 argv）与 `emitDeepLinkUrl()`（热启动点击协议）。`resetIpcMock()` 一起清干净。
- 新增两组用例：`cell-display.test.tsx` 在 jsdom 里真点 url/email 单元格（没写协议的补 `https://`、邮箱加 `mailto:`、`javascript:` 退化成纯文本不打边界、系统拒绝拉起时出声且按钮还能再点），`grid-view.test.tsx` 把 CSV 导入整条链跑通（选文件 → 解析 → 弹类型确认 → 按文件名建表 → 打 `csv_import`，并断言取消时一条命令都不发）。此前这条链只有头（`CsvImportDialog` 的附件选择）和尾（`csv.ts` 的解析与类型推断）各自有单测，中间的接线没人管。

### 工程：lib 的纯读取不再反向依赖 store（P3 第一批）

- 新增 `src/lib/app-context.ts`：界面语言、当前页面树、当前工作区 id 这三样纯读取收成单点，lib 侧改成 `appLang()` / `appTree()` / `appWorkspaceId()`；stores 在自己的模块体里 `bindAppReaders(...)`（`stores/settings.ts` 绑语言，`stores/workspace.ts` 绑树与工作区），依赖方向回到 features → stores → lib → types。注册/注销形制沿用 `close-flush.ts`、`ai-editor.ts`。
- 兜底口径是分开定的：语言未绑定回落注册表首项（`t()` 是全仓消费点，不该在这里抛），页面树与工作区未绑定直接抛——把「还没绑」当成「没有页面」会让整目录导出静默返回 0 个文件、让 AI 回「页面不存在」，属于最难查的一类假象。
- 换源的读取点共 8 处：`i18n.ts` 的 `t()`（签名一字未动，`useLanguage()` 的订阅仍走 store）、`daily-notes.ts` 的配置默认值、`ai-citation.ts` 的引用标题解析、`export-folder.ts` 的整目录导出、`ai-tools.ts` 的 `resolvePage` / `renderTree` / 检索工具。
- 补了能脱离 store 跑的用例：`app-context.test.ts`（绑定、注销、未绑定的两种兜底）、`i18n.test.ts`（跑在无 window 的 node 环境，证明取文案不再拖进整条 settings store）、`ai-citation.test.ts` 的注入树、`daily-notes.test.ts` 的语言注入、`export-folder.test.ts` 改为直接喂页面树并新增「未绑定抛错」一条；`ai-tools.test.ts` 不再靠 store mock 提供树。反方向由 `src/stores/app-binding.test.ts` 用真 store 验那两次 `bindAppReaders`（改语言后 `t()` 跟着换字典、store 换了树 lib 侧立刻读到新值），绑定被删或绑成快照都会在这里先炸。新增用例 20 条，套件 89 文件 / 1265 通过。
- `src/lib` 里剩下的 `@/stores` 引用是写侧与订阅侧（`ai-tools.ts` 的 `renameView`/`reload`、`deep-link.ts` 的 `openView`/行聚焦/订阅、`export-page.ts` 的编辑器实例、`update-check.ts` 与 `db-health.ts` 的 `setRoute`、`i18n.ts` 的 `useLanguage`），属 service 语义，按注册表统一收口另批处理。

### 工程：lib 的写动作与订阅也不再反向依赖 store（P3 第二批）

- `src/lib/app-context.ts` 在只读注册表旁边补了写侧登记表 `AppActions`：`reload`（刷页面树）、`renameView`、`openView`、`setRoute`、`invalidateRelations`、`setFocusRow`、`subscribeWorkspace` 共 7 项，lib 侧只说「要做这件事」（`appReload()` / `appOpenView(id)` …），实现在 stores 模块求值时 `bindAppActions(...)` 装上（`stores/workspace.ts` 5 项、`relation.ts` 1 项、`row-focus.ts` 1 项）。字段名与 store 里的同名动作对齐，读代码不用换脑子；`setRoute` 的界面名收成 `AppRoute = "settings"` 这一真用得上的值，绑定方与 store 的 Route 不兼容时 tsc 立刻报。
- 兜底口径延续第一批的分法：写侧没有「合理的默认动作」可回落，未绑定一律抛且指名缺哪一项（不靠 `undefined` 的 TypeError 让人猜）。绑的是取值/动作函数而不是模块求值那一刻的快照，store 换了实现或重载了页面树，lib 侧自然跟着。
- 换源的调用点共 18 处：`ai-tools.ts` 11 处（2 处 `reload`、2 处 `renameView`、6 处关联失效、1 处「AI 没指定父页面就挂在当前页下」读当前页），`deep-link.ts` 3 处（开页、行聚焦、工作区订阅），`export-page.ts` 2 处（长图/PDF 导出读活的编辑器实例，`stores/editor.ts` 负责绑），`update-check.ts` 与 `db-health.ts` 各 1 处（提示条上「去设置页」）。
- 测试面不再需要 `vi.mock("@/stores/…")`：新增 `src/test/app-fakes.ts`——`bindFakeApp()` 一次把 5 项读取绑成可变对象、7 个动作绑成同名 `vi.fn`，另有 `set()` 换读到的值、`emitWorkspaceChange()` 模拟「store 变了」、`fakeEditor()` 给导出用例一个最小编辑器，`dispose()` 做成幂等（用例里提前解绑后 afterEach 再清一次不会回滚掉别人的绑定）。`ai-tools.test.ts`、`deep-link.test.ts`、`export-page.test.ts`、`update-check.test.ts`、`db-health.test.ts` 改用假运行态。
- `deep-link.ts` 那段「目标页还没进树就先订阅等它出现，等满 15s 放弃并记日志」的排队逻辑，此前只能靠整条 store 替身才测得到，补了 6 条脱 store 用例：树里已有则立刻开页并落到行聚焦 / 不传 rowId 就不碰行聚焦 / 子树里的页面也算命中 / 还没出现时等着、变化后开且只开一次 / 超时退订后来出现也不跳 / 没绑运行态直接抛而不是静默当成「页面不存在」。
- 反方向的守卫从读取扩到写侧：`src/stores/app-binding.test.ts` 新增 3 条用真 store 验那 7 个动作真装上了。workspace 那 4 项把 store 上的同名方法临时换成 spy 再调 lib 侧——要是绑成了模块求值时的函数快照，这里就调不到 spy、真实现会去碰 IPC，用例当场红；行聚焦与关联失效断言落到真状态；订阅那条断言注销函数确实退订。
- 新增用例 12 条，套件 89 文件 / 1277 通过；`tsc --noEmit`、`eslint --max-warnings=0`、`npm run build`、`cargo test`（343 通过 / 1 忽略）均与上一批持平。
- 这一批做完，`src/lib` 里 `@/stores` 的引用只剩 1 处：`i18n.ts:3` 为 `useLanguage()` 引 `useSettingsStore`。它是 React 订阅（切换语言后要触发重渲染），当时判断「注册表注入的是取值函数与动作，给不了订阅」——下一批证明这个判断只对了一半，见下面那条。

### 工程：语言订阅收进同一个注册表，src/lib 对 stores 的引用归零（P3 第三批）

- `useLanguage()` 不再直连 `useSettingsStore`：`src/lib/app-context.ts` 的 `AppActions` 多了一项 `subscribeLang`（语言变化时回调、返回取消函数），hook 由 app-context 自己用 `useSyncExternalStore(subscribeLang, appLang, appLang)` 组，读的仍是 `appLang()` 那一份；`stores/settings.ts` 只交 `useSettingsStore.subscribe` 这一半。上一批说「注册表给不了订阅」只对了一半：给不了的是把 hook 当普通值传来传去（react-compiler 明确拦这种写法），能给的是订阅本身。
- 口径与改之前一致：快照比的是语言，所以 store 里改主题、字体这些别的设置项不会连带让订阅方重渲染（`useSettingsStore((s) => s.lang)` 选值本来也是这个行为）；未绑定 `subscribeLang` 时和写侧一样直接抛，不退化成「读一次值」——那种实现看着能用，切语言后界面不刷新，是最难发现的一类失效。
- `src/lib/i18n.ts` 的 `@/stores` 引用删除，`t()` 与 `useLanguage()` 的签名一字未动，全仓唯一调用点 `App.tsx` 不用改。至此 `src/lib` 里对 `@/stores` 的引用为 0（上一批剩 1 处）。
- 用例补了三处：`src/lib/i18n.test.ts` 在 node 环境钉住「没绑订阅就抛」和「只绑读取不绑订阅也抛」；新增 `src/lib/use-language.test.tsx`（jsdom + `bindFakeApp` 的假订阅，验「触发订阅才重渲染」「只改值不广播就不重渲染」「卸载后取消订阅」）；新增 `src/stores/app-binding-lang.test.tsx`（真 store 探针：`setLang` 后同一次挂载就刷新、挂载前改过语言的新探针读到新值、改别的设置项不多渲染一次）。两组守卫各做过一次变异核验：把 hook 退化成 `appLang()` 读一次值 → 4 条用例红；把 stores 交的订阅换成从不回调的空实现 → 3 条用例红，确认它们不是摆设。
- `src/test/app-fakes.ts` 的假动作跟着加上 `subscribeLang` 与 `emitLangChange()`，用例不必再引真 store 就能驱动一次语言变更广播。
- 新增用例 10 条、测试文件 2 个，套件 91 文件 / 1287 通过；`tsc --noEmit`、`eslint --max-warnings=0`、`npm run build`、`cargo test`（343 通过 / 1 忽略）均通过。

### 发布链路：latest.json 的更新说明取自 更新说明.md

- `scripts/gen-latest-json.mjs` 的 `notes` 不再默认写成 `TsFlowy v{version}` 占位串，改为从仓库根目录的 `更新说明.md` 取本版章节（`## v{version}` 起、到下一个 `## ` 之前、去掉结尾的 `---`），与 `gh release create --notes-file` 用的是同一份内容，安装包里的说明和更新清单不会再有两份说法。
- 本版章节缺失时脚本直接报错退出，不再静默产出占位文案；确实要手写成一条，用 `--notes` 显式传入。
- 补了章节抽取的用例：版本段边界（`0.8.3` 不会命中 `v0.8.30`）、结尾分隔线剔除、真实 更新说明.md 里本版章节只含本版内容。

### 工程：切语言在原生窗口里验了一遍（CDP 冒烟脚本）

- P3 第三批的「切语言后整棵界面刷新」此前只有 jsdom 探针证据；新增 `scripts/cdp-lang-smoke.mjs`：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev` 起真窗口，脚本经 CDP 点侧栏齿轮进设置、把语言下拉改成 English 再改回简体中文，逐步断言侧栏文案（设置 → Settings → 设置）、`<html lang>`（zh-CN → en-US → zh-CN）与设置页正文跟着重渲染，并收集整场的 `Runtime.exceptionThrown`，非零即失败退出。
- 实跑结果：11 条断言全过、0 未捕获异常，界面回到起始语言。脚本是手工冒烟工具，没进 CI（CI 里没有可用的 WebView2 会话），跑法写在脚本头部注释。

### 工程：`db/database.rs` 按域拆成目录模块（2393 行 → 单文件最大 476 行）

- 纯搬运，不改一行逻辑：`src-tauri/src/db/database.rs` 变成目录模块 `src-tauri/src/db/database/`，父模块 `mod.rs` 只留三表总注、`TRIGGER_MANAGED_TIMESTAMPS`、`default_options_json()` 与跨域共用的 `next_position()`（86 行），字段域 467 行、行域 476 行、单元格与 CSV 导入 147 行各自成文件。
- 对外路径一字未动：`mod.rs` 用 `pub use fields::*; pub use rows::*; pub use cells::*;` 把三个子模块的公开函数平铺回 `crate::db::database::*`，`commands/db.rs`、`commands/files/config.rs`、`db/search.rs`、`db/views/crud.rs` 这 32 个调用点一个都不用改，Rust 侧命令名与 SQL 也完全一致。
- 45 个用例同样按域拆进 `database/tests/`（`mod.rs` 76 行只放 `setup()` 等共享夹具，`fields`/`rows`/`cells`/`trash`/`view_id` 各一个文件），子模块靠 `use super::*` 拿夹具、夹具自己 `use super::*` 拿领域函数，断言内容未改。
- 唯一的可见性放宽是搬运的必然代价：`fields::paired_field_id()` 从「与用例同文件」变成要有 `pub(super)` 才能被 `tests` 取到，作用域仍限在 `db::database` 内部，没有对外暴露新符号。
- 拆的过程中撞到一个非本批引入的问题：`desktop.rs:323` 那段用例在 HEAD 上就不是 rustfmt 干净的，`cargo fmt` 顺手会改掉别人的文件；已把这处还原回 HEAD，格式检查只针对本批的 10 个文件跑（`rustfmt --edition 2021`），落差单记在下条。
- 验证：函数清单 97 个与拆前逐字一致，`cargo clippy --all-targets` 无告警，`cargo test` 343 通过 / 1 忽略（与拆前基线持平）。

### 工程：`commands/ai_protocol.rs` 按域拆成目录模块（1396 行 → 单文件最大 600 行）

- 纯搬运，不改一行逻辑：`src-tauri/src/commands/ai_protocol.rs` 变成目录模块 `ai_protocol/`。父模块 275 行留 `Protocol` / `Endpoint`、请求头、三家共用的 URL 归一与消息/工具辅助函数以及 `chat()` / `models()` 分派；`providers.rs`（262 行）是三家的请求体构造（OpenAI 兼容 / Anthropic / Gemini）；`sse.rs`（276 行）是非流式响应解析（连通性测试、模型列表）与 SSE 帧解码器；`tests.rs`（600 行）15 个用例。
- 对外路径一字未动：`pub use sse::*;` 让 `commands/ai/chat.rs` 里的 `super::ai_protocol::{SseDecoder, completion_text, model_ids, …}` 照常解析；三家 body 构造本来是私有的，只有父模块的 `chat()` 分派它们，故升 `pub(super)` 并在父模块显式 `use providers::{anthropic_body, gemini_body, openai_body};`（同一批学到的规则：`pub use` 的 glob 不透出 `pub(super)` 项）。
- 用例里的 SSE / tool_calls 帧样本是多行 raw string，缩进降层交给 `rustfmt` 而非手工去缩进，逐行核对 23 处 raw string 内容未变。
- 验证：顶层符号与 HEAD 逐条对上，四份文件与 HEAD 做空白归一后的逐行比对只剩本批新增的注释与 import；`cargo test` 343 通过 / 1 忽略、clippy 无告警、`cargo fmt --check` 干净。

### 工程：`commands/db.rs` 按资源拆成目录模块（906 行 / 77 个命令 → 单文件最大 289 行）

- 纯搬运：`src-tauri/src/commands/db.rs` 变成 `db/`，按命令资源的既有分节切成五块——`workspace.rs`（62 行，workspace 5 个命令 + app_settings 2 个）、`views.rs`（260 行，view 23 个命令 + page_properties 4 个）、`documents.rs`（116 行，文档正文 / 历史快照 / mentions / search）、`ai_sessions.rs`（130 行，AI 会话与用量统计）、`tables.rs`（289 行，fields / rows / cells 与 CSV 导入）；父模块 79 行只留参数契约总注、`check_id` / `check_name` 这两个持久层边界的第二道防线与 `#[cfg(test)] mod entry_checks`（它只测这两个校验函数，留在父模块最省事）。
- 77 个 `#[tauri::command]` 拆前拆后计数一致，`lib.rs` 的 `generate_handler!` 与前端 `invoke("…")` 的命令名一字未改，靠五个 `pub use <域>::*` 平铺回 `crate::commands::db::*`。
- 一处父模块新增绑定：文档快照策略那两处 `super::files::load_app_config(...)` 原本指 `commands::files`，搬进子模块后 `super` 变成了 `commands::db`；选择不在搬出的代码里改路径，而在父模块加 `use super::files;` 让原表达式继续解析——这样这两行仍是逐字节搬运。
- 验证：四份文件与 HEAD 做空白归一后的逐行比对，差集只有本批新增的注释、`mod` 声明与 `use super::*;`，没有任何一行原代码被改写；`cargo test` 343 通过 / 1 忽略、clippy 无告警、`cargo fmt --check` 与 `npm run format:check` 均干净。
- 至此本批点名的四个巨型命令文件（`db/database.rs`、`commands/sync.rs`、`commands/ai.rs`、`commands/ai_protocol.rs`、`commands/db.rs`）全部 ≤800 行。`src-tauri/src` 里仍超 800 行的是 `db/migrations.rs` 1,722（迁移按时间追加，拆开反而读不动）、`db/search.rs` 1,257、`commands/files/backup.rs` 1,172、`db/views/tests.rs` 1,047、`commands/files/config.rs` 844——不在本批范围。

### 工程：CI 的 `cargo fmt --check` 转绿

- 上一批记的落差收了口：`desktop.rs:323` 那段用例在 HEAD 上就不是 rustfmt 干净的，CI 的 `cargo fmt --check`（`.github/workflows/ci.yml:55`）从那次起一直是红的，本批之前的格式检查只能「对改动文件单独跑 rustfmt」来绕开。
- 按 rustfmt 的写法把那两行折回来（只换折行位置，不改语义），现在全仓 `cargo fmt --check` exit 0，后续批次可以正常跑格式检查。

### 工程：`commands/sync.rs` 按域拆成目录模块（1629 行 → 单文件最大 765 行）

- 纯搬运，不改一行逻辑：`src-tauri/src/commands/sync.rs` 变成目录模块 `sync/`。父模块 765 行留「同步目录 + 文件系统原语 + 冲突裁决」，其中 LWW 裁决那一段（`remote_is_newer` / `decide` / `db_activity_ms` / `activity_label` / `info_of`）按禁区约定连位置都没挪；`run.rs`（310 行）装「跑一轮同步」的命令与流程（`get_sync_info` / `get_sync_history` / `clear_sync_history` / `set_sync_dir` / `open_sync_dir` / `run_sync` / `run_sync_blocking` 及内部的 `push_history` / `run_sync_inner` / `pull_into_local` / `restore_stashed_db`）；`tests.rs`（561 行）是原来的 24 个用例，断言未改。
- 对外路径一字未动：父模块 `pub use run::*;`，`lib.rs` 里 10 条 `commands::sync::…` 的 `generate_handler!` 条目与前端命令名保持原样，冲突域（`conflicts/`）那几个命令仍留在父模块。
- 可见性放宽 3 个函数（`push_history` / `run_sync_inner` / `pull_into_local` 加 `pub(super)`）：前两个被用例直接调用，`pull_into_local` 被留在父模块的「用冲突副本恢复本机库」复用。这里撞到一条 Rust 规则——`pub use 子模块::*` 的 glob 不透出 `pub(super)` 项，所以父模块与 `tests` 各补了一行显式 `use …::run::{…}`，作用域仍限在 `commands::sync` 内部。
- 验证：顶层符号清单 95 条与拆前逐项对上（差异只有新增的 `mod run` 声明与 3 处 `pub(super)` 前缀），搬出的 307 行与 HEAD 逐字节一致（除那 3 个前缀），`cargo test` 343 通过 / 1 忽略、`cargo clippy --all-targets` 无告警。

### 工程：`commands/ai.rs` 按域拆成目录模块（1854 行 → 单文件最大 624 行）

- 同样纯搬运：`src-tauri/src/commands/ai.rs` 变成 `ai/`。父模块 351 行留文件总注、取消世代计数、超时/退避常量与全部前后端共用的类型（`AiMessage` / `AiImage` / `AiToolCall` / `AiChatRequest` / `AiUsage` / `AiEvent` / `AiConfigPublic` / `AiConfigInput` / `AiProfileInput` / `AiQuickActionInput` 与两个 `normalize_*`），跨域共用的都留在父模块、子模块用 `use super::*` 取；`config.rs`（410 行）是 5 个配置命令（`ai_get_config` / `ai_save_config` / `ai_test_connection` / `ai_list_models` / `ai_cancel`）加掩码视图 `public_of` / `mask_api_key` 与「生效配置」解析（`effective_api_key` / `effective_profile_key` / `apply_profile` / `request_ready` / `effective_ai`）；`chat.rs`（624 行）是流式对话的传输层（`ai_chat` / `stream_once` / 重试 / 取消 / 图片内联 / HTTP 客户端）与 SSE 帧、错误码解析；`tests.rs`（486 行）26 个用例。
- 对外路径一字未动：`pub use chat::*; pub use config::*;`，`lib.rs` 的 6 条 `commands::ai::…` handler、`commands/ai_protocol.rs` 的互调与前端命令名全部保持原样；`pub(crate)` 的 `extract_error_message` / `parse_sse_line` / `parse_completion_text` / `inline_images` 经 glob 仍以 `crate::commands::ai::…` 可见。
- 可见性放宽 12 个原本私有的函数到 `pub(super)`（作用域仍限在 `commands::ai` 内）并配 4 行显式跨子模块 `use`：`chat` 需要 `effective_ai`，`config` 需要 `build_client` / `readable_http_error`，用例另外需要 `collect_tool_calls` / `error_code` / `guess_error_code` / `image_media_type` / `mask_api_key` / `parse_retry_after` / `request_ready` / `apply_profile` / `retryable_status`。
- 用例从 `mod tests { … }` 里搬出来要降一层缩进，但里面有多行 raw string 的 SSE 帧样本（含「并行多工具调用」那条），手工降缩进会改掉字符串内容；改成先原样搬出再交给 `rustfmt`——它只重排代码、不动字符串字面量，逐行核对确认样本字节一致。
- 唯一一处非搬运的文字改动：父模块顶上的 `//!` 总注原来写「本文件只管一次流式请求的生命周期」，拆完这话不再成立，改成「共用的常量与类型在本文件，配置在 `config.rs`、流式在 `chat.rs`」。注释，不涉及任何行为。
- 验证：顶层符号清单 80 条与拆前对上（差集只有 2 条 `mod` 声明、12 处 `pub(super)` 前缀、`mod tests {` → `mod tests;`），四份文件与 HEAD 做空白归一后的逐行比对只剩本批新增的注释与 import；`cargo test` 343 通过 / 1 忽略、`cargo clippy --all-targets` 无告警、`cargo fmt --check` 与 `npm run format:check` 均干净。
- 本批全链：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest` 91 文件 / 1287 用例全过、`npm run build` exit 0、`cargo test` 343 通过 / 1 忽略。Rust 侧动了命令的模块归属，静态检查之外又在原生窗口里重跑了一遍 CDP 冒烟（`scripts/cdp-lang-smoke.mjs`，11 条断言全过、0 未捕获异常），确认 `generate_handler!` 的注册路径与界面启动都没被拆坏。

### 工程：`db/search.rs` 按「词法 / 查询」两层拆成目录模块（1257 行 → 单文件最大 421 行）

- 同样纯搬运：`src-tauri/src/db/search.rs` 变成 `search/`。`terms.rs`（106 行）拿走近乎纯函数的那一层——FTS5 转义、把查询串切成 `QueryTerm`（空白分词、`"…"` 精确短语、`-` 前缀排除）、由项拼 `MATCH` 表达式与 LIKE 模式；`query.rs`（301 行）管「一次查询怎么跑出来」——文档 FTS、数据库单元格 FTS、页面别名、三路 LIKE 兜底、回收站过滤、AI 上下文用的单篇片段检索；父模块 25 行留共用导入与 `dedupe_by_view`（跨路去重是两层共用的收口）。
- 对外路径一字未动：`pub use query::*; pub use terms::*;`，`commands/db/{documents,ai_sessions}.rs` 的 `db::search::search(...)` / `search_in_view(...)` 与 `db/docs.rs` 的 `super::search::like_pattern(...)` 都不用改。
- 1,257 行里有 840 行是 `#[cfg(test)] mod tests`，按被测层拆成四份：`tests/mod.rs`（43 行，`setup()` 建库与两个 seed 夹具）、`tests/terms.rs`（128 行）、`tests/query.rs`（421 行）、`tests/cells.rs`（260 行，迁移 008 的单元格索引）。54 个 `#[test]` 拆前拆后计数一致，断言一行没动；降缩进同样交给 `rustfmt`，不手工 awk（里面有 raw string 样本）。
- 两处必要的路径/可见性适配（不改逻辑）：`like_filters` 是「词法项 → SQL 片段」的拼串、实现在 `query.rs` 却被 `tests/terms.rs` 断言，放宽到 `pub(super)` 并在用例里显式 `use`（`pub use` 的 glob 不透出 `pub(super)`）；`tests/cells.rs` 调 `soft_delete_rows` 的 `super::super::database` 因层级多了一处，换成绝对路径 `crate::db::database::`。
- 验证：七份文件与 HEAD 做空白归一后的逐行比对，差集只有本批新增的注释、`mod` / `use` 声明和上述两行适配，没有一行原代码被改写；`cargo test` 343 通过 / 1 忽略、`cargo clippy --all-targets` 无告警、`cargo fmt --check` 干净。
- 拆完 `src-tauri/src` 里仍超 800 行的只剩 `db/migrations.rs` 1,722（迁移按时间追加，拆开反而读不动）、`commands/files/backup.rs` 1,172、`db/views/tests.rs` 1,047（单个用例集，不是混杂职责）、`commands/files/config.rs` 844。

### 工程：`commands/files/backup.rs` 按「导出 / 恢复」两条链拆成目录模块（1,172 行 → 单文件最大 540 行）

- 同样纯搬运：`src-tauri/src/commands/files/backup.rs` 变成 `backup/`。父模块 90 行留文件头总注、共用导入与「归档范围」这层两条链共用的语义（`BackupScope`、`impl BackupScope`、清单条目名 `MANIFEST_ENTRY`、`BackupManifest`、`scope_from_manifest_text`、`read_backup_scope`）；`export.rs`（229 行）管导出与打包——VACUUM INTO 快照、zip 落盘、迁移前留档与它的清理；`import.rs`（338 行）管恢复与导入——归档校验、把现有库与附件改名让位（`.bak-时间戳`）、解压覆盖、失败回滚；`tests.rs`（540 行）是原来 `mod tests` 的 12 个用例。
- 对外路径一字未动：`pub use export::*; pub use import::*;`，`files/mod.rs` 的 `pub use backup::{export_backup, import_backup}` 与 `pub(crate) use backup::{make_db_snapshot, stash_current_db}`、`auto_backup.rs` 引的 `write_backup_zip` / `restore_backup_from` / `scope_from_manifest_text` / `BackupScope` / `MANIFEST_ENTRY`、`db/migrations.rs` 的 `backup::capture_pre_migration` 全部照原样解析。2 个 `#[tauri::command]` 拆前拆后计数一致。
- 一处父模块新增绑定（同 `db.rs` 那批的写法）：恢复链路里 `super::health::deep_check_failure(...)` 原本指 `commands::files::health`，搬进 `import.rs` 后 `super` 变成了 `commands::files::backup`；不在被搬的代码里改路径，而在父模块加 `use super::health;` 让原表达式继续解析。
- 可见性放宽 5 个原本私有的函数到 `pub(super)`（作用域仍限在 `backup` 内）：`export::prune_pre_migration`、`import::{prune_stale_backups, validate_backup_zip, import_backup_into, move_db_sidecars_to_bak}`，都是用例直接点的内部函数；用例里补两行显式 `use super::{export,import}::{…}`。
- 验证：四份文件与 HEAD 做空白归一后的逐行比对，差集只有本批新增的注释、`mod` / `use` 声明、5 处 `pub(super)` 前缀与 `mod tests {` → `mod tests;`；12 个 `#[test]` 计数一致（降缩进交给 `rustfmt`，raw string 样本未动）；`cargo test` 343 通过 / 1 忽略、`cargo clippy --all-targets` 无告警、`cargo fmt --check` 干净。

### 工程：`commands/files/config.rs` 按「数据形状 / 命令 / 落盘」三层拆成目录模块（844 行 → 单文件最大 503 行）

- 同样纯搬运：`src-tauri/src/commands/files/config.rs` 变成 `config/`。父模块 24 行留共用导入与两个目录/文件名常量（`CONFIG_DIR_NAME`、`CONFIG_FILE_NAME`）；`types.rs`（503 行）是配置的数据形状——`AppConfig` 与 AI / 同步 / 自动备份 / 快照 / 回收站 / 唤起快捷键各子块，连同默认值函数与 clamp/normalize 口径；`commands.rs`（95 行）是设置页读写的那几条命令（`get/set_retention_policy`、`get/set_prefs`、`run_expired_trash_sweep`、`RetentionPolicyInfo`、`retention_info`、`PREF_VALUE_MAX_BYTES`）；`store.rs`（87 行）管落盘（目录解析、损坏配置的救援式加载、先写临时文件再 rename 的读写）；`tests.rs`（154 行）8 个用例。
- 对外路径一字未动：三条 `pub use <子>::*;`，`files/mod.rs` 里逐名列出的 `config::{AppConfig, AiConfig, …}`、`config::{get_prefs, set_prefs, get_retention_policy, set_retention_policy, run_expired_trash_sweep, RetentionPolicyInfo}`、`pub(crate) use config::{load_app_config, save_app_config}` 与 `__cmd__…` / `__tauri_command_name_…` 那批宏生成项都能照原样解析，`generate_handler!` 未改。4 个 `#[tauri::command]`、8 个 `#[test]` 计数一致。
- 本批零可见性放宽、零 `super::` 路径适配：跨层引用的 `load_app_config` / `save_app_config` 本就是 `pub(crate)`，靠 glob 透出。
- 验证：五份文件与 HEAD 做空白归一后的逐行比对，差集只有本批新增的注释、`mod` / `pub use` 声明与 `mod tests {` → `mod tests;`；顶层符号清单一致（多出的 8 条正是降缩进后进入顶层统计的用例函数）。
- 至此批次内点名的三个文件（`db/search.rs`、`commands/files/backup.rs`、`commands/files/config.rs`）全部 ≤800 行，本批全链：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest` 91 文件 / 1287 用例全过、`npm run build` exit 0、`cargo test` 343 通过 / 1 忽略。`src-tauri/src` 里仍超 800 行的只剩 `db/migrations.rs` 1,722（迁移按版本号顺序追加，是时间线不是混杂职责，拆开反而读不动）与 `db/views/tests.rs` 1,047（单个用例集）。

### 工程：`src/lib/markdown.ts` 按「导入 / 导出」两侧拆成目录模块（1,143 行 → 单文件最大 679 行）

- Rust 侧收完后前端的第一批，同样纯搬运：`src/lib/markdown.ts` 变成 `src/lib/markdown/`。`parse.ts`（679 行）是导入侧——行内语法解析、`looksLikeMarkdown` 判定、纯文本转块、`markdownToJson` 整篇解析与列宽比例；`render.ts`（467 行）是导出侧，从原文件 675 行那条分节注释开始整段搬出——`jsonToMarkdown` 与各块的序列化、`colorAttr` / `alignValueOf` / `calloutColorOf`；`index.ts`（5 行）只做一件事：显式再导出原来那 9 个对外名字。
- 对外路径一字未动：`src/lib/markdown/` 的目录 index 在 `moduleResolution: "bundler"` 下照旧解析，8 个 `@/lib/markdown` 消费方（`features/editor/EditorPage.tsx`、`stores/ai.ts`、`lib/{ai-locate,ai-tools,doc-diff,export-folder,export-page,import-folder}.ts`）与 `markdown.test.ts` 的 `./markdown` 一行没改；测试文件仍留在 `src/lib/markdown.test.ts`，不跟着搬。index 用逐名再导出而不是 `export *`，正是为了让 `parse.ts` 多出来的那几个内部常量不会因此漏进对外面。
- 唯一的可见性变化：4 个原本文件私有的常量在 `parse.ts` 加 `export`（`DB_TABLE_BEGIN` / `DB_TABLE_END` / `CALLOUT_COLORS` / `ATTACH_PREFIX`），因为导出侧要读同一份协议名单与色表；`columnRatioOf` 本就是导出的。原先猜要跨侧的 `ALIGN_RE` 与 `stripAlign` 查了引用后确认只有导入侧用，于是把 `stripAlign` 连着它的注释从 902 行整块搬到 `parse.ts` 末尾，两者都保持文件私有——拆完两侧各自 `tsc` 报出的未用 import 反过来印证了这个判断。
- 三个 import 按各半的实际用量分写而不是照抄：`JSONContent` 两侧都要，`t` 只有导出侧用（`databaseView.defaultName`），`task-meta` 那 5 项里导入侧用 `EMPTY_TASK_META` / `stripTaskMeta` / `TaskMeta`、导出侧用 `encodeTaskMeta` / `taskMetaOf`。
- 验证：`parse.ts` 与 `render.ts` 的函数体逐行对 HEAD 的 `markdown.ts` 做归一比对，除上述 4 处 `export` 前缀外完全相等；行数对账 1,143 = 1,138 行原代码 + 新增的 5 行 `index.ts`。本批只动 TS，全链：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest` 91 文件 / 1287 用例全过（与基线一致）、`npm run build` exit 0、`npm run format:check` 干净；`cargo test` 复跑仍是 343 通过 / 1 忽略。

### 工程：`src/lib/markdown.test.ts` 跟着源码两侧拆开（1,345 行 → 单文件最大 509 行）

- 上一批把 `markdown.ts` 拆成 `parse.ts` / `render.ts` 之后，配套用例还是一份 1,345 行的文件，这次按同一道缝搬过去：`markdown/parse.test.ts`（364 行）是 `parseInline` / `markdownToJson` / `looksLikeMarkdown`+`textToBlocks` 三个 describe；`markdown/render.test.ts`（509 行）是 `jsonToMarkdown` 里「渲染成什么」的那一半（标题级别、行内标记、列表、代码、图片、表格、数学、toggle、分栏比例…）；`markdown/roundtrip.test.ts`（478 行）是「导出再读回」的那一半（原 873 行起的 round-trip 序列，加上 `hardBreak 往返`、`databaseView 附表快照`、`toggle 与单元格的细节保真` 三个整段 describe）。
- 用例文本一字未动：90 个 `it(` 拆前拆后计数一致，非空行做多重集比对，差集只有为了让 `roundtrip.test.ts` 独立成立而复开的一对 `describe("jsonToMarkdown", () => { … });`（用的还是原名，所以报告里的用例路径不变）。三个文件各留自己实际用到的 import，`JSONContent` 只有往返那份需要。
- 测试文件跟着被测源码住进 `src/lib/markdown/`，与 `stores/workspace-slices/tree.test.ts` 的同目录放法一致；vitest 收集数因此从 91 文件变 93 文件，用例总数仍是 1,287。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略（本批未动 Rust）。

### 工程：给 jsdom 组件用例留出超时余量，全量 `vitest run` 不再随机红

- 症状：`npx vitest run` 全量并行时随机红 1~3 条，每次不是同一条——`features/database/csv-import-dialog`、`features/database/FieldTypeMenu`、`features/search/GlobalReplaceDialog`、`features/database/grid-view` 这几份 `.test.tsx` 报 `Test timed out in 5000ms`；把这几份单独跑或整仓串行（`--no-file-parallelism`）都全绿。和拆用例那批没有因果关系，只是机器负载高的时候更容易撞到。
- 定位：这几条用例空闲时实测 0.7~1.0s（`userEvent` 真实派发 + radix 弹窗动画等待），多文件并行抢 CPU 会放大到 5s 以上，撞的是 vitest 默认 `testTimeout: 5000`，不是用例逻辑或组件行为有问题。顺带核了 CI 上唯一一次红（2026-10-20 发布那次），失败的是「从 CHANGELOG 抽取发布 notes」那条断言，跟这里不是一回事。
- 改法只动测试配置：`vitest.config.ts` 的 `test.testTimeout` 设 15000，并注明为什么。给的是争用下的余量，不是提速——用例本身该跑多久还是多久；应用代码、断言与被测组件一字未动。也没顺手改成串行：`--no-file-parallelism` 只当定位用的对照口径（本机串行 113s、无争用时并行 41s、争用时并行能拖到 130~160s），把整仓文件并行关掉换来的东西比问题本身更贵。
- 验证：全量并行连跑两次皆 93 文件 / 1287 用例全过（各约 41s）；`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。

### 工程：`stores/ai.ts` 先切出「无状态」的那一半（1,943 行 → 五个叶子模块 + 1,438 行）

- 这一批只搬不动 store 本体：把 `src/stores/ai.ts` 里不碰 `set`/`get`、不碰那三个轮次闭包变量（`streamingAssistantId`/`turnSeq`/`cancelledTurns`）的部分切进 `src/stores/ai/`——`types.ts`（184 行，动作记录 / 消息 / 会话 / `AiState` 形状）、`calls.ts`（93 行，指令块与用量的小工具）、`prompts.ts`（43 行，快捷动作文案 key 与提示词精修 prompt）、`limits.ts`（35 行，宽度与各类兜底上限、localStorage 键名）、`session-codec.ts`（195 行，会话快照读写、坏数据清洗、会话行 ↔ 本地形状）。先切这一刀是因为它整块能搬：动 store 本体的那批改动要靠注入上下文，两边混在一批里，验证信号会被稀释。
- `index.ts` 的 `export` 面与原文件逐字对账：仍是原来那 12 个名字（`useAiStore`、`AI_WIDTH_LIMITS`、`DEFAULT_AGENT_ROUNDS`、`DEFAULT_HISTORY_MAX_MESSAGES`、`DEFAULT_HISTORY_TOKEN_BUDGET`、`visibleSessionWindow` 与 5 个类型），一条多一条少都没有（6 个类型 + `useAiStore` + 5 个值/函数），也没有用 `export *`——叶子模块为了互相引用新 widened 出来的符号（`sanitizeUsage`、`toSessionRow`、`loadWidth` 等 33 个）不对 `@/stores/ai` 的消费者可见。`moduleResolution: "bundler"` 下 `@/stores/ai` 会解析到目录 `index.ts`，8 个消费方（`App.tsx`、`AiPanel`、`EditDiffDialog`、`floating-menu`、`slash-menu`、`CommandPalette`、`SettingsAi`、`TabBar`）的 import 一行没改。
- `currentPageRef()` 故意留在 `index.ts`：它读 `useWorkspaceStore.getState()` 与 `flattenTree`，搬进 `session-codec` 会让「会话编解码」这个模块重新长回依赖 store 的样子；等下面那批做注入时再安置。`stores/ai.test.ts` 也没动：它 mock 的是 `@/lib/ai`、`@/stores/workspace` 这些下游模块，搬动 `stores/ai` 内部的分文件不影响 `vi.mock` 的命中。
- 验证口径还是老那三条：五个叶子文件与原 `ai.ts` 对应行段逐字相等（只多 `export ` 前缀），172/79/39/33/185 行对得上；`index.ts` 里从 `currentPageRef` 到文件尾的 1,351 行与原 `310–316` + `601–1943` 逐字节相等；导出面 12=12。`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过（41.65s）、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。界面没碰，行为口径不变；照例没有在浏览器里冒烟（本应用浏览器打开必白屏）。
- 落差：`index.ts` 还有 1,438 行，超着 800 行的线。剩下的是 `create<AiState>()((set,get)=>{…})` 的本体——`return {`（原 1381 行）之前那 28 个闭包助手几乎都要 `set`/`get`，拆它们得先给每个切片一个上下文对象，那正是下一批要定的形状。

### 工程：把「不读 store 状态」的动作构件搬出 `create` 闭包（`index.ts` 1,438 → 1,324 行）

- 新增 `src/stores/ai/ops.ts`（133 行）：`archiveCurrent`（当前对话归档进 sessions）、`importLocalSessions`（localStorage 老归档补导进库）、`configPayload`（面板改一个字段时的整份回写载荷，少带一项就等于把它悄悄重置成默认值）、`LOCATE_REASON`（定位失败原因 → 文案 key）、`editorTarget` / `bridgeFor`（落地桥接怎么选）、`sessionUsageTotal`（会话用量三元组）。这七个的共同点是把参数给足就不碰 `set`/`get`，也不碰 `streamingAssistantId`/`turnSeq`/`cancelledTurns` 那三个轮次变量——它们本来被每个 store 实例重建一次，纯函数挪到模块作用域行为不变。
- 判定口径写清楚，免得下批照着抄错：`dropSessions` 看着没有捕获就漏了它，实际是 `.then(fetchUsage)` 把函数当引用传下去，按名字找 `fetchUsage(` 的粗筛扫不到，它仍留在闭包里；`systemMessage`/`previewAction`/`landAction`/`persistSessions` 同理，它们调的 `ctxScope`/`maxChars`/`editOnPage`/`activeSnapshot` 要读状态，得等切片化那批给上下文。
- 搬法是逐字移动：整块连同上方注释摘出、每行去掉两个缩进、加 `export`，调用点一行没改（`index.ts` 从 `./ops` 导入同名）。对账即按这个口径做的——去掉 `export ` 前缀与 2 格缩进后与 `HEAD` 逐字节相等。`index.ts` 那侧的净变化是 13 增 127 删：增的全是 import 行（4 个因搬走而改写的 + 新 `./ops` 那 9 行），删的 127 = 搬走的 115 行 + 7 个块后空行 + 5 个 import 行（4 个改写 + 1 行纯删的 `type AiConfig,`）。顺带清掉 `index.ts` 里因此不再被引用的 5 个 import（`AiConfig`、`getAiEditorForView`、`LocateFailure`、`MessageKey`、`SessionUsage`）——`noUnusedLocals` 会把当年「整份抄 import 头」的多余项全报出来，这本身就是核对。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过（42.62s）、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。用例数没动，纯移动不改行为。界面依旧只能在 `npm run tauri dev` 的原生窗口里看，没做浏览器冒烟。

### 工程：会话落盘收成 `createPersistSlice(set, get)`（`index.ts` 1,324 → 1,245 行）

- 新增 `src/stores/ai/persist.ts`（98 行）：`fetchUsage`（跨会话 token 累计，库不可用时清掉就好、不弹错）、`writeLocal`（localStorage 兜底，配额溢出丢一半最老归档重试一次）、`activeSnapshot`（进行中对话的快照，无消息时为 null）、`saveSession`（按条 upsert 落库，失败退回本地并记日志）、`dropSessions`（删库里的会话，等写请求落地再重取用量）、`persistSessions`、`applyLocal`（本地老数据直接充当当前状态）。这七件都读写 store 状态，所以不能像上一批那样搬去模块作用域，改成切片工厂 `createPersistSlice(set, get) => { …; return { … } }`。
- 注入不改变语义：`create<AiState>()((set, get) => …)` 的这两个参数本来就是它们原来捕获的那两个函数；`AiSet` / `AiGet` 取 `StoreApi<AiState>["setState" | "getState"]`，`AiSliceCreator<T>` 与 `stores/workspace-slices/types.ts` 的 `WorkspaceSet` / `WorkspaceGet` / `WorkspaceSliceCreator` 同一形制，两个 store 的切片读起来是一套写法。
- **实现逐字未动**：七个助手在工厂里本来就是 2 格缩进，切片工厂体同为 2 格，整块搬过去不需要 dedent，与 `HEAD` 比对只有我加的一行说明注释多出来（`writeLocal` / `activeSnapshot` 只被切片内部互调，所以不放进对外动作面，接口因此比返回对象少两个名字）。
- 调用点零改动是关键设计：`index.ts` 里解构 `const { fetchUsage, saveSession, dropSessions, persistSessions, applyLocal } = createPersistSlice(set, get);`，名字与原来一模一样，那 33 处调用（`newChat` / `switchSession` / `clear` / `branchFrom` / `send` 收尾等）一行都不用改。`index.ts` 净 4 增 83 删，顺带清掉因此不再被引用的 6 个 specifier（`aiSessionSave` / `aiSessionDelete` / `aiUsageSummary` / `SESSIONS_KEY` / `LocalSessions` / `toSessionRow`）——还是靠 `noUnusedLocals` 报出来当核对。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过（本轮机器负载高，103s，仍全绿）、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。用例数与断言未动；`stores/ai.test.ts` 的 88 条里覆盖落库、删会话与「db down 退 localStorage」这些路径，切片化后照样命中（它 mock 的仍是 `@/lib/ai` 下游，不依赖这些助手写在哪个文件里）。
- 落差：`index.ts` 仍 1,245 行 >800。剩 `return {`（现 683 行）之前 15 个助手——配置派生 4（`maxChars` / `agentRounds` / `halvedContextBudget` / `ctxScope`）、请求构造 3（`systemMessage` / `requestMessages` / `buildReferenceContext`）、定位与落地 4（`editOnPage` / `previewAction` / `landAction` / `planAction`）、流式 4（`settleIncomplete` / `finalizeAssistant` / `streamRound` / `runStream`），外加 `return {` 之后约 560 行的动作实现面。下一批切配置派生 + 请求构造这一簇（7 个约 130 行，它们只读 `get()`，注入面最小），流式那四个共同读写 `streamingAssistantId` / `turnSeq` / `cancelledTurns` 三个轮次变量，要连着一个 `turnRegistry` 一起定形，留到最后单独一批。

### 工程：出请求那一侧的派生与组装收成 `createRequestSlice(get)`（`index.ts` 1,245 → 1,068 行）

- 新增 `src/stores/ai/request-slice.ts`（203 行）：配置读数 `maxChars`（上下文字符数）、`agentRounds`（一次提问允许的模型往返轮数，兜底 4 轮）、`halvedContextBudget`（撞上下文上限后补发用的预算砍一半，低于 500 token 就不值得再试）、`ctxScope`（只认 `page_only` / `off`，没有可编辑文档时 `page_only` 与 `full` 等价），与请求构造 `systemMessage`（有文档时下发编辑协议 + 文档上下文，无文档退化成纯问答）、`requestMessages`（system + 参考文档 + 选中内容 + 按 token 预算从最新往前收的历史窗，发生截断时显式告知模型）、`buildReferenceContext`（`@文件名` 引用 → 参考上下文：短文档整篇给出，长文档先按问题检索片段，没命中才截断并写明截了多少）。
- 这一簇七个都只读状态、不写状态，所以注入的是 `get` 一个参数（`createRequestSlice(get: AiGet): AiRequestActions`），而不是上一批的 `(set, get)`。`systemMessage` 只被 `requestMessages` 调用，因此不进 `AiRequestActions` 对外动作面——接口 6 个名字，比搬走的实现少一个，跟 `persist.ts` 里 `writeLocal` / `activeSnapshot` 同一条口径。
- **实现逐字未动，163 行连一行注释都没加**：切片工厂体与 store 工厂体同为 2 格缩进，整块搬过去不需要 dedent，所以带反引号的模板字符串（`requestMessages` 的截断告知、`buildReferenceContext` 的参考上下文拼装）不会被改到；与 `HEAD` 逐行比对结果是 `EQUAL`。`index.ts` 净 6 增 183 删，增的是 1 行 import + 同名解构 2 行 + 1 行说明 + 2 行改写的 import；解构出的 6 个名字与原来一致，`index.ts` 里那 10 处调用（`send` / `retry` 的降预算补发、quickAction 取正文截断等）一行没改。搬走后不再被引用的 14 个 specifier 由 `noUnusedLocals` 逐个报出并清掉（报在 13 条错里，`@/lib/ai-tokens` 那行两个一起空）：`docSearchSnippets`、ai-edit 那 4 个协议常量、`parseMentions`、`estimateTokens` / `tailTokens`、`jsonToMarkdown`、`parseViewAliases`、limits 那 4 个默认值。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。上下文预算与截断告知、`@` 引用这些路径在 `stores/ai.test.ts`、`ai-tokens.test.ts`、`ai-mention.test.ts` 里有用例，切片化后照样命中。没碰界面，也没做浏览器冒烟。
- 落差：`index.ts` 仍 1,068 行 >800。剩 `return {` 之前 8 个助手（定位与落地 4：`editOnPage` / `previewAction` / `landAction` / `planAction`；流式 4：`settleIncomplete` / `finalizeAssistant` / `streamRound` / `runStream`）与 `return {` 之后约 560 行的动作实现面。定位与落地这簇里 `planAction` 读写 `cancelledTurns`，流式那簇四个共同读写 `streamingAssistantId` / `turnSeq` / `cancelledTurns`——三个轮次变量的归属是下一个决定，不再属于「搬」。

### 工程：定位与落地三个构件搬出闭包（`index.ts` 1,068 → 967 行）

- 新增 `src/stores/ai/edit-ops.ts`（101 行）：`editOnPage`（对非当前页做定位编辑，`save=false` 只演练一遍以取改前原文、判断能不能定位到）、`previewAction`（动作落点与可行性预览，`blocked` 非空表示这条动作执行不了）、`landAction`（真正执行：打开中的页面走编辑器事务可撤销，其它页面走 JSON 直写，建页/改标题/写库走各自路径）。
- 这一簇三件都不读 store 状态、也不碰轮次变量（入参给足，编辑器桥接与当前页由 `ops.ts` 里那两个读取器现取），所以按第二批的口径直接 hoist 成模块级普通函数，不套切片工厂、不注入 `set` / `get`——与三、四批不同形是刻意的：那里注入是因为真读了状态。`editOnPage` 只被同文件的另两件调用，不进导出面（`writeLocal` / `activeSnapshot` / `systemMessage` 同一条口径），导出只有 `previewAction`、`landAction` 两个名字。
- `planAction` 留在 `index.ts`：它读 `cancelledTurns`（用户按停止后迟到的 done 帧不能替用户写数据）和 `get().config?.confirm_edit`，注不注入都改变不了「它持有轮次判定」这件事，硬搬等于替下一批的 `turnRegistry` 做决定。
- 实现是逐字搬运，但有 2 处 prettier 因去缩进/加 `export` 而重排的空白：`editOnPage` 里 `raw ? asDoc(…) : { type: "doc", content: [] }` 这个三元去缩进后行宽够了被并成一行；`previewAction` 加了 `export ` 后单行超过 120，参数被换行并补上尾逗号。除这两处与两个 `export ` 前缀外，与 `HEAD` 的 token 流完全一致（去掉空白逐字比对），语义零改动。`index.ts` 净 3 增 104 删，`planAction` 里对 `previewAction` / `landAction` 的两处调用一行没改；搬走后不再被引用的 specifier 由 `noUnusedLocals` 报出并清掉（`applyEditToDocJson` / `asDoc`、`documentApi`、`JSONContent`、`ViewNode` 四行整行删，ai-edit 的 `AiEditAnchor` / `AiEditOp` 与 `resolvePage`、`LOCATE_REASON` / `bridgeFor` / `editorTarget` 五个名字摘掉）。`@/stores/ai` 对外符号清单仍是拆前那 12 个。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。跨页编辑与落地判定在 `stores/ai.test.ts` 有用例（含「没打开的页面走 JSON 直写」「confirm_edit 开启时停在待确认」），hoist 后照样命中。没碰界面，也没做浏览器冒烟。
- 落差：`index.ts` 仍 967 行 >800。剩 5 个闭包助手——`settleIncomplete`（用 `set`）、`planAction`、流式三件 `finalizeAssistant` / `streamRound` / `runStream`（共同读写 `streamingAssistantId` / `turnSeq` / `cancelledTurns`）——与 `return {`（第 405 行）之后约 560 行的动作实现面。下一批要么先定 `turnRegistry`（把三个轮次变量收成一个可注入的持有者，这一步是设计决定不是搬运），要么改切动作面里的独立域；不再能在「只搬不改」里自动推出。

### 工程：动作面先切走不碰轮次的两组动作（`index.ts` 967 → 876 行）

- 新增 `src/stores/ai/config-slice.ts`（48 行）：`loadConfig`（拉配置回填）、`setConfig`（整份覆盖）、`switchProfile`（切档位，只改 `active_profile` 其余原样回传）、`setCtxScope`（上下文范围，改完下一轮生效）。
- 新增 `src/stores/ai/panel-slice.ts`（81 行）：`toggle` / `openPanel` / `closePanel` / `setWidth`（宽度夹在上下限内并写 localStorage）/ `setPendingContext` / `startEdit` / `cancelEdit` / `refinePrompt`（改写提问的一次性请求，不进对话）/ `clearPromptIdeas`。
- 两个切片写成**块体工厂** `= (set, get) => { return { … } }`：属性正好落在动作面里原来的 4 格缩进上，所以这次连去缩进都没有——88 行搬过去与 `HEAD` **逐字节相等**（比第五批更干净，那批被 prettier 重排了两处空白）。类型面也不新写接口，用 `Pick<AiState, "loadConfig" | …>` 直接取 `types.ts` 里已声明的动作签名，「抄签名」这一步从流程里删掉。接线沿用 `stores/workspace.ts` 的先例：`return { ...createConfigSlice(set, get), ...createPanelSlice(set, get), 其余 }`。`index.ts` 净 8 增 99 删，`@/stores/ai` 对外符号仍 12 个。
- 顺带把动作面的依赖关系勘察清楚了（下一批的依据）：`return {` 之后 562 行里真正锁在闭包簇上的只有 5 处——`send` / `retry` / `regenerate` / `resend` 调 `runStream`，`stop` 读写 `streamingAssistantId` / `turnSeq` / `cancelledTurns`。剩下两组：会话历史 9 件（`loadSessions` / `clear` / `newChat` / `switchSession` / `deleteSession` / `renameSession` / `setSessionArchived` / `branchFrom` / `loadMoreSessions`）要用 `saveSession` / `dropSessions` / `applyLocal` / `fetchUsage`；动作卡片 + 消息导出 6 件（`rateMessage` / `undoAction` / `applyAction` / `rejectAction` / `saveMessageAsPage` / `exportMessage`）要用 `persistSessions` 与 `landAction`。
- 落差：`index.ts` 876 行仍 >800。上面那两个跨切片依赖的落盘动作**不在 `AiState` 上**（`types.ts:83` 没声明，只有 `persist.ts` 的 `AiPersistActions` 声明，靠 `index.ts` 闭包里解构使用），所以切它们的调用方只能把函数本身当参数注入新切片（同名参数 → 调用文本一字不改）；另一条路是把这些动作提升成 `AiState` 上的公开面再 `get().saveSession(...)` 调，那要改对外形状，不算机械搬运，本轮不擅自选。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。面板开关、宽度持久化、档位切换、`refinePrompt` 的改写结果与失败提示在 `stores/ai.test.ts` 有用例，切片化后照样命中。没碰界面，也没做浏览器冒烟。

### 工程：会话历史九个动作切出切片，`index.ts` 首次降到 800 行以下（876 → 708）

- 新增 `src/stores/ai/session-slice.ts`（192 行）：`loadSessions`（优先从库里读历史会话，库空或不可用才回退本地老数据并尝试一次性导入）、`loadMoreSessions`（放宽面板显示窗口）、`clear`（清空即按 id 销毁这条会话）、`newChat`、`switchSession`、`deleteSession`、`renameSession`、`setSessionArchived`、`branchFrom`（从某条消息前缀分出一条新会话，原对话整段归档保留）。
- 先了结上一批留的落差：这四个落盘动作（`saveSession` / `dropSessions` / `applyLocal` / `fetchUsage`）确实**不在 `AiState` 上**（`types.ts:83` 没声明，只有 `persist.ts` 的 `AiPersistActions` 声明，运行时也不在 store 对象里——`index.ts` 是把 `createPersistSlice` 的返回值解构使用，没有 spread 进去），所以 `get().saveSession(…)` 这条路根本不通，要走就得先把它们提升成对外动作面、改 `createPersistSlice` 的接法，那是形状变更，不属机械搬运。选定**同名参数注入**：`createSessionSlice(set, get, { saveSession, dropSessions, applyLocal, fetchUsage }: AiPersistDeps)`，`AiPersistDeps = Pick<AiPersistActions, …>`（复用已有接口，不新写类型）；因为注入的形参与闭包里的解构同名，九个动作的实现文本一字没改。
- 延续 6a 的块体工厂写法（`=> { return { … } }`，属性仍落在 4 格缩进上）：158 行搬过去与 `HEAD` **逐字节相等**，零 dedent、零 prettier 重排。`index.ts` 净 1 条 spread + 1 行 import，摘掉 6 个不再被引用的 specifier（`aiSessionList` / `AiSessionRow` / `logger` 整条 / `archiveCurrent` / `importLocalSessions` / `fromSessionRow` / `sessionTitle` / `StoredSession`），`@/stores/ai` 对外符号仍 12 个。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。这九个动作在 `stores/ai.test.ts` 里全部有用例（`loadSessions` 的库/本地两条来源与导入失败回退、`clear` 删库行、`switchSession` 先归档、`renameSession` 去重与截断、`branchFrom` 归档原文并保留两条线，共 49 处引用），用例跑的是真 store 实例，所以切片 spread 的接线与注入的函数身份都在运行时被真打过一遍。没碰界面，也没做浏览器冒烟（白屏限制照旧）。
- 落差：`index.ts` 708 行，>800 这条纪律第一次达标。剩下的动作面只有 6c（`rateMessage` / `undoAction` / `applyAction` / `rejectAction` / `saveMessageAsPage` / `exportMessage` 六件，注入 `persistSessions`）与闭包簇那一整块，后者要先拍板 `turnRegistry`。
- 上一条里「闭包簇整块都要等 `turnRegistry`」这个判断是过宽的，6c 开工前逐个依赖核对后更正：`streamRound` 不读任何轮次变量；`planAction` 只 `cancelledTurns.has(turnId)`，而 `cancelledTurns` 是 `const` 的 `Set`，按引用同名注入就能保持文本不变；`finalizeAssistant` 与 `settleIncomplete` 只用 `set`。这 149 行是可机械搬的。真正卡住的只有 `runStream`（现 `index.ts:252`）与 `stop`（`:462`）——它们对 `streamingAssistantId` / `turnSeq` 是**给 `let` 标量重新赋值**（`=`、`++`），按引用注入换不掉重新赋值，这两个才需要 `turnRegistry`。

### 工程：单条消息上的六个动作切出 `message-slice.ts`（`index.ts` 708 → 598）

- 新增 `src/stores/ai/message-slice.ts`（137 行）：`rateMessage`（点赞/点踩写在消息上、点同一次取消）、`undoAction`（页面与表数据按落库时留下的逆操作计划回滚，文档编辑按编辑器 undo 栈回滚，撤不动时明确告知）、`applyAction`（diff 预览后点「应用」才真正写数据）、`rejectAction`、`saveMessageAsPage`（把一条回答按首行取标题落成新页）、`exportMessage`（走保存对话框把回答导成 `.md`）。
- 延续 6a/6b 的块体工厂 + 同名注入：`createMessageSlice(set, get, { persistSessions }: Pick<AiPersistActions, "persistSessions">)`，四个要落盘的动作直接吃注入的那个 `persistSessions`；`landAction` 上一批已在 `edit-ops.ts` 成模块函数，这里 import 即用。六个动作 111 行搬过去与 `HEAD` **逐字节相等**，零 dedent、零 prettier 重排。
- `index.ts` 净 1 条 spread + 1 行 import，摘掉 5 个不再被引用的 specifier：`save`（`@/lib/ipc-dialog`）与 `invoke`（`@/lib/invoke`）两条 import 整条删掉，`runUndoPlan` / `runWriteAction` 从 `@/lib/ai-tools` 的解构里摘走、`pageTitleFrom` 从 `./prompts` 里摘走；`aiErrorText` / `getAiEditor` / `landAction` 因闭包簇仍在用而留下。`@/stores/ai` 对外符号仍 12 个，消费方一行没改。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。六个动作里四个在 `stores/ai.test.ts` 有用例并跑真 store 实例（`rateMessage` 4 处：打分、换票、重复点取消；`undoAction` 4 处：逆操作计划回滚、撤不动时报错、撤文档编辑；`applyAction` 1 处：pending 落地后状态改写；`saveMessageAsPage` 1 处：按回答首行取标题建页），所以 spread 接线与注入的函数身份在运行时被真打过。没碰界面，也没做浏览器冒烟（白屏限制照旧）。
- 落差：① `rejectAction` 与 `exportMessage` 全仓零用例（`grep` 过 `*.test.ts(x)` 无命中，本批之前就没有），搬运只靠静态对账，属既有测试缺口，不是本批引入；② `format:check` 第一次报红是删除块尾巴上留下的一个空行（`  };` 前），删掉即绿，非行为变更。
- 下一批候选（不需拍板）：`streamRound` + `planAction` + `finalizeAssistant` + `settleIncomplete` 这 149 行收成 `stream-slice.ts`，`planAction` 按引用注入 `cancelledTurns`；`send` / `retry` / `regenerate` / `resend` 只要调 `runStream`，可以留到 `turnRegistry` 定案之后。

### 工程：流式一轮请求与收尾的四个助手切出 `stream-slice.ts`（`index.ts` 598 → 428）

- 新增 `src/stores/ai/stream-slice.ts`（179 行）：`settleIncomplete`（中断收尾：空的助手占位直接丢弃，有内容的半截回答留下并标记中断类型）、`planAction`（一条写动作先预览，再按 `confirm_edit` 与被停止的轮次决定停在待确认还是立即落地）、`finalizeAssistant`（正文剥掉指令块、写动作逐条预览落地、检索被丢弃时补说明）、`streamRound`（发一轮模型请求，含 60ms 增量节流、思考增量单独累积、用量累积与取消/报错归类）。
- 形制沿用第三批 `persist.ts`：**这四个不是 store 动作、`AiState` 上没有它们**，所以工厂返回一个具名函数对象、由 `index` 解构使用（不是 spread 进 `return {`）。工厂体本身就是 2 格缩进，与原 `create` 闭包体一致，于是四个助手**原样搬过去、连缩进都不用改**，158 行实现体与 `HEAD` 逐字节相等，零 dedent、零 prettier 重排——比 6c 的属性写法更机械，代价是切片末尾多一行具名 `return`。
- 注入的是两个**按引用即可**的捕获：`cancelledTurns`（`const` 的 `Set`，切片只 `has`）与 `ctxScope`（出请求切片里的函数，`streamRound` 用它判「仅本页」不下发工具）。参数类型写成 `AiRequestActions["ctxScope"]` 索引类型，不重抄签名，省掉一处最容易写错的地方。`index` 侧的解构同步改名成三个（`planAction` 只被同切片的 `finalizeAssistant` 调，不再暴露给 `index`）。
- `index.ts` 摘掉 8 个不再被引用的 specifier：`aiChat` / `AiChatEvent` / `AiToolCallRaw` / `extractCalls` / `hideEditBlock` / `aiToolSpecs` / `AiActionRecord` / `addUsage` / `contentOf` / `invalidActionRecord` / `summaryOf`，`./edit-ops` 那条整行删掉（`landAction` / `previewAction` 已随切片走）；剪短后 `@/lib/ai` 与 `./calls` 两条 import 从多行折成单行（prettier 口径，token 流不变）。diff 实测 11 增 181 删，增行只有 import 折叠后的三行、`createStreamSlice` 的解构与注释。
- 验证：`tsc --noEmit` exit 0、`eslint --max-warnings=0` exit 0、`vitest run` 93 文件 / 1287 用例全过、`npm run build` exit 0、`npm run format:check` 干净、`cargo test` 343 通过 / 1 忽略。这四个助手在 `stores/ai.test.ts` 里没有按名引用，但它们是 `send` 唯一能走的通路，用例覆盖到每一条分支：`streamRound` 由「send 走通」「cancelled 尾帧：保留半截不计为错误」打到；`planAction` / `finalizeAssistant` 由「停止后迟到的 done 帧带编辑指令：停在待确认，不自动写文档」「`confirm_edit` 关闭时直接落地为 applied」「多个写动作各一张卡片」打到——**这条注入 `cancelledTurns` 尤其要真跑**，用例证明注入进来的还是同一个 `Set` 实例；`settleIncomplete` 由「retry：半截失败/用户停止的回答被丢弃重发」与「检索阶段点停止」打到。没碰界面，也没做浏览器冒烟（白屏限制照旧）。
- 落差：上一批预告「预计 598 → ~450」，实际 **428**，差在两条 import 被 prettier 折成单行、以及 `planAction` 不再从 `index` 解构，属预估偏保守，不是漏搬。
- 剩下 `index.ts` 428 行里，`runStream`（现 `index.ts:82`）与 `stop`（`:292`）仍要等 `turnRegistry`：`runStream` 给两个 `let` 标量**重新赋值**（`streamingAssistantId = assistantId`、`const turnId = ++turnSeq`），`stop` 则**读它们的当前值**（`if (streamingAssistantId) cancelledTurns.add(turnSeq)`）。按引用注入只能传进那一刻的快照，传不了「以后会被改掉的标量」，所以这两个必须把 `streamingAssistantId` / `turnSeq` / `cancelledTurns` 先收成一个小对象（`turnRegistry`）——那是形状变更，另案。`send` / `retry` / `regenerate` / `resend` 只是调 `runStream`，跟着同一批定。机械搬运这条路到此已经见底。

### 工程：`stores/ai.test.ts` 按主题拆成三个用例文件（1,790 行 → 单文件最大 753 行）

- 删除 `src/stores/ai.test.ts`（1,790 行 / 12 个 describe / 88 条用例），换成三个按主题分文件的用例：`src/stores/ai-stream.test.ts`（650 行，32 条：一轮问答、agent 多步循环、停止取消与重试、上下文预算与截断提示）、`src/stores/ai-context.test.ts`（447 行，23 条：上下文范围开关、图片附件、token 用量累计、档位切换回传整份配置）、`src/stores/ai-session.test.ts`（753 行，33 条：会话生命周期、动作卡片随会话恢复、消息级操作、会话归档、改名与回答评分）。describe 是 12 分成 4+4+4、用例是 88 分成 32+23+33，一条没增没删；每个文件内的 describe 也保持原文件的先后顺序，切分只发生在块边界上。
- 新增 `src/test/ai-store-harness.ts`（181 行）：原文件第 82–224 行的共享骨架——模块级 `idTick` / `streamHandlers` / `storage`、`defaultConfig`、`LoadOptions` 与 `Store` 类型、`loadStore`（重装载 store 模块并把 `aiChat` 桩成可手动投喂事件的形式）、`pump` / `completeTurn` / `loadConfiguredStore` / `startTurn` 四个 helper、`EDIT_FULL` 常量、`session()` 构造器，以及根级 `beforeEach`（清 mock、撤 global 桩、复位工作桩上的 `currentViewId` 与 `tree`）。逐字搬过去，只给 11 个符号加 `export ` 前缀。
- 桩包 `M`（`vi.hoisted` 的 23 个 `vi.fn` + `workspaceState` + `bridge`）与 9 条 `vi.mock` **每个用例文件各留一份**（原第 5–80 行，76 行 × 3），没有抽进 harness：`vi.mock` 与 `vi.hoisted` 由 vitest 提升到**本文件**的 import 之前，工厂里不能引用提升后并不存在的外部名字，跨模块共享会踩空。仓库既没配 `setupFiles` 也没有 `__mocks__` 目录（全仓 37 个测试文件各自带 mock 表），把 mock 收进全局 setup 是测试环境的行为变更，不属这批的「搬」。代价写清楚：这 76 行现在有三份，改桩要改三处。
- 桩包交回 harness 的形制对齐 `lib/app-context.ts` 的 `bindAppReaders`：各文件模块体里调一次 `bindAiMocks(M)`，harness 的 helper 通过闭包变量 `M` 用它。`AiStoreMocks` 里 17 个函数位写成 vitest 的 `Mock`、`workspaceState` / `bridge` 给窄结构类型。`streamHandlers` 是 `export let` 且 `loadStore` 会对它整体重新赋值，跨文件读到的是最新那个数组——靠 ESM live binding（Vite 的 SSR 转换保留这一语义）；这条不是理论保证，用例真走到了：`send` 起一轮后 `pump` 与 `startTurn` 返回的 `feed` 都在读它。
- 对账两个方向都可复核。**正向**（原 1,790 行 → 四文件）：剥掉 `export ` 前缀再按整行查，除 import 头外的原文非空行**未命中只有 1 行**，就是原第 208 行 `const EDIT_FULL = '…'`——加了 `export` 后超 120 列被 prettier 拆成两行，本批唯一一次重排；不剥前缀则未命中 11 行，正是那 11 个加 `export` 的符号行（原 83 / 84 / 86 / 124 / 127 / 172 / 182 / 195 / 202 / 208 / 210）。**反向**（四文件 → 原文）：四个文件里「原文没有的非空行」共 81 行，逐条核过全是接线成本——harness 的说明注释 4 行、`AiStoreMocks` 接口 21 行、`let M` 与 `bindAiMocks` 5 行、`EDIT_FULL` 拆出的 2 行、harness 顶部 vitest import 1 行，其余是 3 × (每文件 3 行说明 + 14~16 行 harness import + 1 行 `bindAiMocks(M)`)。**没有一行是新写的逻辑**。
- 验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npx vitest run src/stores/` 10 文件 / 153 用例全过、全量 `npx vitest run` **95 文件 / 1287 用例**（拆前 93 文件 / 1287 条：减一增三、条数没动）、`npm run format:check` 干净、`npm run build` exit 0（49.59s）、`cargo test` 343 通过 / 1 忽略（与基线一致）。套件 stderr 里那三条 `Error: db down` 重新跑了一遍核对：`[ai session save to db failed, fallback to localStorage]` 两条来自 `src/stores/ai-session.test.ts:182`「落库失败：回写 localStorage 兜底而不是丢历史」，`[ai sessions import from localStorage failed]` 一条来自 `:223`「loadSessions：导入失败时保留本地副本，下次启动重试」——都是用例故意把 `aiSessionSave` 桩成 reject 以覆盖兜底路径，`logger.error` 打出来的，不是本批引入的噪声。没碰界面，也没做浏览器冒烟（白屏限制照旧）。
- 落差：① 三份 mock 表是 vitest 提升规则的必然结果，收成一份要动 `setupFiles` 或 `__mocks__`，属全局测试配置变更，另案；② `AiStoreMocks` 用宽松的 `Mock`，桩的入参/返回类型不再逐个校验（原文件的 `M` 是 `vi.hoisted` 匿名对象，本来也只有个别处带类型标注），这层严格度靠 `loadStore` 里的默认实现与运行期用例兜住；③ 全仓 >800 行的文件现在只剩三个界面组件（`GridView.tsx` 1,450 / `AiPanel.tsx` 1,383 / `EditorPage.tsx` 1,216），切它们要先拍板组件边界，不在「只搬不改」里能推出。
- 下一批：机械搬运两条线都见底了——`stores/ai/index.ts` 卡在 `turnRegistry`（上面那条），>800 的只剩三个组件。要么拍板 `turnRegistry` 的形状，要么给组件切分定边界，要么转去做有用户价值的功能。

### 工程：`AiPanel.tsx` 的顶层小件与纯函数外迁（1,383 → 968 行）

- 新增 `src/features/ai/MessageBubble.tsx`（295 行）：一条消息的渲染（正文气泡 + AI 动作卡片 + 写回与消息级操作），连同只有它用得上的私有件 `MarkdownMemo`、`TOOL_LABEL` / `actionStatusText`、`LEGACY_DETAIL_KEYS` / `detailText`、`canShowDiff`、`IconAction`、`MiniButton`；对外导出 `MessageBubble` 与 `BubbleApi` 两个名字（`BubbleApi` 是 `AiPanel` 用 `useMemo<BubbleApi>` 组出来的稳定操作集，引用不变才保得住 memo 链，跨文件必须可见）。
- 新增 `src/features/ai/AiParts.tsx`（104 行）：面板与气泡共用的三个展示小件——`ImageThumb`（附件缩略图，URL 异步解析、组件自持 alive 状态）、`RowAction`（历史会话行的悬浮改名/归档/删除）、`QuickButton`（快捷动作条的小按钮）。
- 新增 `src/features/ai/ai-utils.ts`（39 行）：`AI_IMAGE_ACCEPT`（选择框只放行 Rust 侧认得的四种图片）、`filterHistorySessions`（归档分区 + 关键词命中标题或任一消息正文）、`AI_ERROR_HINT`（Rust 下发的错误归类码 → 引导文案）、`safeHost`（Base URL 取主机名，解析失败原样返回）。
- 形制：**整块摘出、零 dedent**——这些本来全是 0 格缩进的顶层声明，15 个块与 `HEAD` 逐字节相等，唯一差异是跨文件用得上的 9 个符号加了 `export ` 前缀；**prettier 一处都没重排**（加前缀后最长行仍在 120 列内）。`AiPanel.tsx` 的主组件主体（原 122–1042 行）逐字节保留，diff 只剩 import 头：摘掉因此不再被引用的 13 个 specifier（`memo`、9 个 lucide 图标、`StoredSession`、`resolveAssetUrl`、`MessageKey`，由 `noUnusedLocals` 逐个报出）与整行 `./Markdown`（改由新文件引）。命名与出处注释沿用本仓先例（组件 PascalCase、纯函数模块 kebab，首行「从 AiPanel.tsx 原样搬出」同 `features/database/grid-row.tsx` 那一族）。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 95 文件 / 1287 用例全过（`AiPanel` 没有组件用例，这条只证明没把别处碰坏）、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 因为 `AiPanel` 零测试，这批补了一次**原生窗口 CDP 真机冒烟**（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev` + `scripts/cdp-inspect.mjs`）：面板展开后 139 个按钮、25 个 `max-w-[85%]` 气泡件、Markdown 块 27 个；`IconAction` 那排消息级操作（改这条提问 / 复制这条 / 从此处分出新会话 / 替换选中 / 插入到光标处 / 从此处重新生成 / 存为页面 / 导出为 Markdown / 这个回答有用 / 这个回答不行）逐个在 DOM 里命中；`MiniButton`「查看改动」在动作卡片上命中；`QuickButton`「继续生成」命中；空态隐私提示渲染出「本轮对话与当前文档将发送至 api.deepseek.com」，即搬到 `ai-utils.ts` 的 `safeHost()` 真跑过并取到了主机名。全程 0 未捕获异常，结尾把面板收起还原窗口状态。
- 落差：① `RowAction` 与整个历史弹层、以及 `ImageThumb` **没能在真机验到**——这台机器当前 `sessions.length === 0`（历史按钮 `disabled`），要让它出现得先归档一条会话或发一次提问，那是写用户数据、且提问会真打外部 API，冒烟不该顺手做；这两块只有「逐字节相同 + 类型通过 + 构建通过」三件证据。② 动作卡片另外三个 `MiniButton`（应用 / 忽略 / 撤销）要 `confirm_edit` 开着且正有待落地动作才出现，同样没验到。③ `AiPanel.tsx` 968 行仍 >800：剩下的是主组件本体的 JSX，下一处接缝（历史弹层现 `AiPanel.tsx:490–598`、输入区 `:791–937`）都要透传 `pendingDanger` 或 `textareaRef`，属边界决定，不在「只搬不改」里能推出。
- 全仓 >800 行文件现在剩 5 个：`GridView.tsx` 1,450 / `EditorPage.tsx` 1,216 / `AiPanel.tsx` 968 / `i18n/{en,zh}.ts`（一语言一份，不算债）。

### 工程：`GridView.tsx` 的导入导出簇切出 `grid-io-slice.ts`（1,450 → 1,120 行）

- 新增 `src/features/database/grid-io-slice.ts`（404 行）：CSV / xlsx 导出、TSV 剪贴板粘贴、CSV 导入（建新表 + 追加到当前表）这一簇共 7 个闭包助手——`exportCells`（私有）、`exportCsv`、`exportXlsx`、`onPasteTsv`、`importCsv`、`runAppendCsv`（私有）、`runImportCsv`，原样来自 `GridView.tsx` 609–931。
- 形制：这批不是顶层声明，是组件体内的闭包，所以走 `createGridIoSlice(ctx)` 工厂 + **同参数名解构**——函数体在工厂体内仍是 2 格缩进，与在组件体里一模一样，323 行整块与 `HEAD` 逐字节相等、零 dedent、零改写；宿主每次渲染调一次工厂，解构出 5 个动作（`exportCells` / `runAppendCsv` 留在切片内部）。
- 注入的 13 个值全部来自宿主当次渲染（`source` / `fields` / `cells` / `displayRows` / `displayCells` / `relationDbOf` / `visibleFields` / `editing` / `pasteAnchorRef` / `store` / `storeApi` / `importPlan` / `setImportPlan`）。这里的关键是 `importPlan`：它是 React state，闭包读的必须是「本次渲染的快照」才与搬前等价——工厂每次渲染重新求值，快照语义原样保持；`pasteAnchorRef` 传的是 ref 对象本体，`.current` 仍在调用时才读。
- 类型不重抄签名：`fields` 写成 `DatabaseState["fields"]`，`displayRows` / `visibleFields` 写成 `GridModel[……]`，`displayCells` / `relationDbOf` 写成 `UseGridViewModelResult[……]` 索引类型。原先内联在 `useState<{…}>` 里的那个匿名类型（`GridView.tsx` 135–141）收成导出的 `GridImportPlan`，宿主改成 `useState<GridImportPlan | null>(null)`——字段与顺序不变，这是本批唯一一处非「整块摘取」的改动面。
- 因此 `GridView.tsx` 的 diff 只有三处：import 头（`noUnusedLocals` 报出 9 条整行 import 与 `mapWithConcurrency` 一项，删掉；`@/types/database`、`@/lib/database-values` 两行各自减短）、那一条 useState 的类型实参、簇换成 16 行工厂接线。其余逐字节保留（HEAD 的 99–133 / 142–608 / 932–1450 三段全部原样可寻）。
- 补了一条用例（`grid-view.test.tsx` 现 3 条，套件 1,288）：导出 CSV 用替身喂 2 字段 / 2 行 / 1 个格值，断言前置 BOM、`名称,数量` 表头、两行都带出（第二行没写过值是一行空逗号）、`write_text_file` 的 `path` 与 `save` 对话框的 `defaultPath="客户.csv"`（文件名取宿主页面标题）。这条链此前零覆盖，而它正是「切片靠注入拿数据」的接缝所在——做了变异核验：把传给工厂的 `displayRows` 换成 `[]`，用例当场红（只出 `['名称,数量','']`）。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净（搬运部分零重排，prettier 只动新写的用例与 import 行）、`vitest run` 95 文件 / 1,288 用例全过、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `exportXlsx`、`onPasteTsv`、`runAppendCsv` 三个仍无运行时证据。前两者与 `exportCsv` 同形（读同一批注入值，分别走 `export_xlsx` 命令与剪贴板事件），追加路径要在 `CsvImportDialog` 里选「追加到当前表」；补三条用例各自要造 fixture，建议另开一批（`queueSaveDialog` 与 `dialogCalls` 已在替身里，成本约 60 行）。② `GridView.tsx` 1,120 行仍 >800：剩下的全是 JSX 与本地 UI state（22 个 `useState`），下一处接缝要么像 `grid-row.tsx` 那样透传几十个字段的 ctx，要么先定 state 归属，属边界决定，不在「只搬不改」里能推出。
- 全仓 >800 行的前端文件从 5 个降到 4 个：`EditorPage.tsx` 1,216 / `AiPanel.tsx` 968 / `i18n/{en,zh}.ts`（一语言一份，不算债）。

### 工程：`EditorPage.tsx` 的模块级小件外迁（1,216 → 1,163 行）

- 新增 `src/features/editor/doc-save.ts`（28 行）：`AUTOSAVE_MS`（800ms 防抖是产品口径）与 `reportSaveMetrics`（落库耗时/体积过阈值才 warn + 会话内一次性提示），连同只有它用的私有三件 `SAVE_SLOW_MS` / `SAVE_BIG_CHARS` / `slowSaveWarned`。原样来自 `EditorPage.tsx` 74–95。
- 新增 `src/features/editor/table-centered.ts`（29 行）：`CenteredTableCell` / `CenteredTableHeader` 两个 tiptap 扩展与私有 `centeredCellAttrs`（align 属性走 v3 表格原生支持，导出/粘贴保留对齐）。原样来自 102–125。
- `src/features/editor/caret-position.ts` 54 → 59 行：`CARET_LINE_RATIO` / `TYPEWRITER_RATIO` 两个常量从 `EditorPage.tsx` 97–100 摘过来，和同文件的 `captureCaretMark` / `resolveCaretPos` 放一起——它们本来就是同一件事（光标行位置）的参数，此前隔着一个 1,200 行文件。该文件已有的 `caret-position.test.ts` 照旧通过。
- 形制：这三处全是 0 格缩进的顶层声明，走 A 批那一族「整块摘出 + 零 dedent」，对外需要的 6 个符号加 `export ` 前缀，私有件不动可见性；prettier 对四个文件都报 unchanged，搬运部分零重排。
- 唯一一处改写是一行注释：`reportSaveMetrics` 里原先写「本文件从 tiptap 导入了 Math 扩展，模块作用域内的 Math 已被遮蔽，不能用 `Math.round`」——搬出新文件后不再有 Math 扩展遮蔽，注释留着会误导，改成说明「取整沿用 `toFixed`，这一段原样搬出」。函数体（`ms.toFixed(0)`）一个字没动。
- 因此 `EditorPage.tsx` 的 diff 只有 import 头：删掉 `TableHeader` / `TableCell` 两行（`noUnusedLocals` 报出）、`./caret-position` 那行加两个 specifier、新增 `./doc-save` 与 `./table-centered` 两行；其余逐字节保留（HEAD 的 127–137 / 138–600 / 601–1216 三段全部原样可寻）。
- 两处刻意留在原地：`ownsPaneShortcuts`（11 行）与 `extractPlainText`（`EditorPage.tsx` 尾部）各自只有一个使用点、且都贴着组件的 DOM/编辑器实例，为它们各开一个模块比留着更难读。（顺带记一笔：`extractPlainText` 与 `ai-locate.ts:60` 的 `textOfNode` 语义高度重叠，dedupe 属行为变更，本批不碰。）
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 95 文件 / 1,288 用例全过（用例数与 C 批相同，本批没加测试）、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 真机只做到「编辑器带着新模块挂载成功」——原生窗口 CDP 探针读到 `.ProseMirror` 在、可编辑、正文是原文，0 未捕获异常；但当前文档里没有表格，`CenteredTableCell` 的 `text-align: center` 没有屏幕证据，补插表格会写用户的真实库，冒烟不该顺手做。② `reportSaveMetrics` 这条路径没跑到：要它执行得改一次正文触发自动保存，同样是写真实数据。它只有「逐字节相同 + 类型通过 + 构建通过」三件证据，而 `vitest` 里也没有覆盖它的用例。③ `EditorPage.tsx` 1,163 行仍 >800：剩下的都是组件本体（状态、效果与 JSX），下一处接缝（反链面板、AI bridge 那个 183 行 effect）要透传 state 归属，属边界决定，不在「只搬不改」里能推出。
- 全仓 >800 行的前端文件还是 3 个，只是排序换了：`EditorPage.tsx` 1,163 / `GridView.tsx` 1,120 / `AiPanel.tsx` 968（`i18n/{en,zh}.ts` 一语言一份，不算债）。

### 工程：`grid-io-slice.ts` 剩下三条接缝各补一条用例（产品代码零改动）

- `src/features/database/grid-view.test.tsx` 134 → 337 行、用例 3 → 6 条（套件 1,291 通过 / 95 文件）。上一批切出切片时只有「导出 CSV」一条管住了注入接缝，`exportXlsx` / `onPasteTsv` / `runAppendCsv` 三条当时明确记为落差，本批补齐：
  - **导出 xlsx**：断言发给 Rust 的载荷形状——`sheet.name` 取宿主标题、`columns` 带列种类（text / number 决定写数值还是文本）、没写过的格是 `null` 而不是空串（否则导出会多出满屏空单元格），加上 `path` 与保存对话框的 `defaultPath="客户.xlsx"`。
  - **TSV 粘贴**：单击锚点格（本仓取态是单击即开编辑框）后按一下 Esc 收手，再派发 paste；三行数据落在只有两行的表上，断言**一次** `row_create_many` 建出缺的那行（不是逐行 await），再逐格核对 `cell_set_many` 的 6 条 snake_case 写入——行 id、列 id、值形态（数字写 `7`、文本写 `"甲"`）全在里面，且没有跳过告警。
  - **CSV 追加到当前表**：在确认对话框里选「追加到」而非「新表」，断言既不打 `view_create` 也不打 `csv_import`（那是建新表那条路的命令），改打建行 + 批量写格；CSV 的第三列「备注」在表里没有同名字段 → 整列跳过并出「已跳过 1 列」的告警。
- 三条都做了变异核验（改 `grid-io-slice.ts` 一处、跑完立刻还原，`git diff` 确认该文件与 `HEAD` 无差异）：`missingRows` 写死 0 → 粘贴那条红；`buildXlsxSheet(… displayRows …)` 换成 `[]` → xlsx 那条红；`runAppendCsv` 里 `const plan = null` → 追加那条红。每次恰好红对应的那一条，说明三条各自管住了自己的接缝。
- 顺带挖出一个**跨用例串数据**的隐患：数据 store 是模块级单例（`DatabaseStoreContext` 的默认值就是它），`cleanup()` 不会清它。上一条用例留下的两字段快照会让本条首帧渲染出旧列——粘贴因此把第三列当成「超出最右列」跳过，写得少一格且不出错。现在 `beforeEach` 里显式 `useDatabaseStore.setState({ viewId: null, view: null, fields: [], rows: [], cells: {}, loading: false })`，粘贴用例 additionally 等到第三列渲染出来才点锚点。这个坑在只读同一份两字段夹具的旧用例里不会露头。
- jsdom 缺的两件按空操作补在用例文件里：`Element.prototype.scrollIntoView`（光标落定后网格要把目标格滚进视口，缺它会抛，而滚动不是这条链要验的东西）；剪贴板则手搓 `paste` 事件、只挂 handler 真正读的 `clipboardData.getData`（jsdom 没有可用的 `DataTransfer`，`fireEvent.paste` 传进去的对象会被丢掉）。
- 夹具收成 `fieldOf` / `rowOf` / `twoByTwo()` / `echoCreatedRows` / `cellWrites()` 五个小件：`echoCreatedRows` 按前端生成的 id 出行（与 Rust 侧同形），断言才认得新行 id；「导出 CSV」那条既有用例改用同一份夹具，断言一字未改。
- 落差：① 这三条走的是各自的主干，切片里的低频分支仍未覆盖——粘贴的「只读/关联列跳过」「选择列缺选项要补建（`degraded`）」「`addRows` 没建够就整片放弃」「没有锚点时提示先点一格」，追加的「附件列 `save_asset` 复制」「全部列都不匹配的报错」，xlsx 的计算列与隐藏列。② 粘贴与追加两条是在 jsdom 里派发事件跑的，浏览器/WebView 的真机行为（真实 `DataTransfer`、真实滚动位置）没验；`row_create_many` 与 `cell_set_many` 的参数形状是对着 `src/lib/database.ts` 的调用点断言的，Rust 侧的落库结果不在本批证据内（`cargo test` 没碰，仍是 343 通过 / 0 失败 / 1 忽略）。

### 工程：组件用例之间的 store 串状态有了统一复位（产品代码零改动）

- 新增 `src/test/store-reset.ts`（33 行）：`resetStores()` 把四条模块级单例（`useDatabaseStore` / `useRelationStore` / `useRowFocusStore` / `useSettingsStore`）整份还原到 import 期抓的那份 `getState()`。
- 为什么不是手写初值清单：上一批加在 `grid-view.test.tsx` 里的内联复位只写了 6 个键，`sorts` / `filters` / `filterMode` 这些都留在外面——漏哪个键就漏一种串数据，而串数据的表现是整文件并行时随机红，不是报错。快照口径一次盖住全部键，以后 store 加字段也不用回来改这里。
- 只走 `setState`、不调 action：settings 的 `setLang` 那类 action 会顺手写 localStorage 并拉起原生侧同步，复位不该产生这些副作用。
- 采用点三处：`grid-view.test.tsx` 换掉内联复位；`stores/app-binding-lang.test.tsx` 的 `afterEach` 原来只清 `{lang, typewriter}` 两项；`cell-display.test.tsx` 也接上——它渲染的 `cell-display.tsx` 读的是真 relation 单例，此前没有任何复位。
- 新增 `src/test/store-reset.test.ts`（2 条用例，node 环境）：四份单例各脏一遍再复位，逐份与 import 期那份 `toEqual`；另一条专挑内联清单漏掉的键断言。变异核验：把 `resetStores` 里 database 那行退回上一批那 6 个键的清单 → 两条用例同时红，红在 `sorts` 没还原（`expected [ { field_id: 'f-1', dir: 'asc' } ] to deeply equal []`），改回即绿。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 96 文件 / 1,293 通过（+2）、`npm run format:check` 干净、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `relation.ts:25` 那个模块级 `inflight` 去重集不在 state 里，`resetStores()` 够不着；它靠每次拉取的 `finally` 自行出队，但没有断言兜着。② `useWorkspaceStore` / `useEditorStore` / `useAiStore` 没纳入：现有组件用例要么把这几条整条 `vi.mock` 掉、要么根本不碰，等真有用例渲染到它们再纳入。

### 工程：`EditorPage.tsx` 的反链面板切出 `BacklinksPanel.tsx`（1,163 → 1,076 行）

- 新增 `src/features/editor/BacklinksPanel.tsx`（111 行）：面板的三份 state（`backlinks` / `backlinkViews` / `backlinksOpen`）、拉取 effect、按来源分组的 memo 与整块 JSX 原样搬出；对外只接 `viewId` 与 `hidden` 两个值 props，由宿主传 `view.id` 与 `focusMode`。
- 形制：JSX 用一对 `<>…</>` 包住原来的条件块，缩进与宿主文件逐格对齐（6 / 8 格），搬过去的 93 行里只有 5 处差异，全是标识符：effect 内 4 处 `view.id` → 参数 `viewId`（含那行注释里的同一个词），条件里 `!focusMode` → `!hidden`。零 dedent、零重排。
- `EditorPage.tsx` 的 diff 共 +3 / −90：加一行 import、删两行只服务于面板的 import（`Link2/ChevronDown/ChevronUp` 与 `mentionsApi`+`MentionRow`，由 `noUnusedLocals` 报出）、面板整块换成 `<BacklinksPanel viewId={view.id} hidden={focusMode} />`。
- 挂载语义没变：原来那块是 JSX 条件，专注模式或没有反链时只是不渲染，state 一直挂在 EditorPage 上；现在不渲染的仍是条件本身，state 归面板自己、组件保持挂载，所以收起状态与已拉到的数据都不丢，切页也只发一次查询。effect 依赖从 `[view.id]` 变成 `[viewId]`，同一个值。
- 一处随迁改写：字数浮层上面那行注释原本举了「`hoverMention`、反链开合」两个纯 UI 重渲染的例子，搬走以后反链开合不再触发 EditorPage 重渲染，例子只留 `hoverMention`。
- 顺带补 `BacklinksPanel.test.tsx`（6 条 jsdom 用例）：切出来的那一刻它第一次能被单独渲染，原来只能肉眼看的几件事有了断言——按来源分组、每组最多露三条但组尾计数是全量、点来源名与点上下文行都打到 `openView`、收起与专注模式都只藏渲染不重拉（`callsFor("mention_list_backlinks")` 恒为 1）、换文档不留旧数据、没有反链时不占位。三条变异核验各红对应的：条件里去掉 `!hidden` → 专注那条红；`slice(0, 3)` 放宽成 `slice(0, 9)` → 4 条红（夹具按「一组 4 条 + 一组 1 条」造，多处依赖三条上限）；effect 里删掉 `setBacklinks([])` → 换文档残留那条红。跑完产品文件逐字节还原。
- 真机（原生窗口 + CDP，全程只读）：当前文档「P4」在库里有 1 条反链，面板标题「被 1 个页面引用」、来源 chip「提示词」、上下文 1 行都在，DOM 里仍位于内容区与字数浮层之间；在窗口里点收起 → 列表变 0 行而标题还在，再点 → 1 行回来。dev 日志 0 error / 0 warn。`workspace_list` / `view_list_by_workspace` / `mention_list_backlinks` 都是读命令，没有写任何用户数据。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 97 文件 / 1,299 通过（+6）、`npm run format:check` 干净、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 上下文行与来源名的点击行为完全一样（都 `openView(srcId)`），那个 `role="button"` 只是让整行可点、不是另一条路；用例照现状断言，没顺手改。② 分组顺序沿用 `backlinks` 数组序（Rust JOIN 的返回序），用例不断言顺序、真机上只有一组也看不出来；要稳定按来源页排序得改 SQL 或加一次 sort，属行为变更。③ `EditorPage.tsx` 1,076 行仍 >800：剩下最大的一块是 AI bridge 那个约 183 行的 effect，它要往外透传十几个编辑器方法，属边界决定，不在「只搬不改」里能推出。
- 全仓 >800 行的前端文件还是 3 个，但第一名换了：`GridView.tsx` 1,120 / `EditorPage.tsx` 1,076 / `AiPanel.tsx` 968（`i18n/{en,zh}.ts` 一语言一份，不算债）。

### 工程：AI 的轮次登记收成容器，agent 循环与「停止」搬出 store 闭包（`index.ts` 428 → 272 行）

- 新增 `src/stores/ai/turn-registry.ts`（26 行）：把 `create` 闭包里的 `let streamingAssistantId` / `let turnSeq` / `const cancelledTurns` 收成一个 `TurnRegistry` 对象（`assistantId` / `seq` / `cancelled`）。卡点就是那两个 `let` 标量——闭包变量被别的模块接走后那边重新赋值、这边读不到，所以 agent 循环与 `stop` 一直是 `index.ts` 里剩下的最后一块。改成对象字段与 `Set` 之后共享的是引用，两边读写同一份；三个值的语义逐字对齐，没有加也没减状态。
- 新增 `src/stores/ai/run-slice.ts`（223 行）：`runStream`（154 行的 agent 循环）与 `stop`（9 行）搬出，注入的是轮次登记 + 出请求切片与流式切片的读数 + `persistSessions`，形制与 `session-slice` / `message-slice` 一致。字节审计：搬的 163 行里只有 8 行不同，全部是 `streamingAssistantId`→`turn.assistantId`、`turnSeq`→`turn.seq`、`cancelledTurns`→`turn.cancelled` 这三个标识符，缩进与语句顺序零改动。
- `src/stores/ai/index.ts`：删掉那三个闭包变量、`runStream` 整块与 `stop` 整块（返回对象里换成 `stop,`），随循环一起走的是 5 条只它用的 import（`aiCancel` / `aiErrorText` / `AiChatMessage` / `AiToolCallRef` / `ai-edit` 与 `ai-tools` 的检索件 / `calls` 的三个判定）。给流式切片注入的那份被停轮号集合换成 `turn.cancelled`——同一个 `Set`、从未重新赋值，所以 `stream-slice.ts` 那四个助手的实现文本一字未改。
- `src/stores/ai/stream-slice.ts`：头部那句「真正被 `let` 标量锁住的 `runStream` / `stop` 留在 index」搬走以后不成立，改成指向 `run-slice.ts`；末尾补一行 `export type AiStreamActions = ReturnType<typeof createStreamSlice>`，供 run 切片按名字 `Pick` 注入项（签名不重写，避免两处漂移）。
- 顺手挖出一个**断言分不清理由**的覆盖洞（本批唯一的用例新增）：既有的那条「停止后迟到的 done 帧带编辑指令：停在待确认」跑在 `confirm_edit` 默认开着的路径上，而 `planAction` 里拦住落地的是「这一轮被停过」**或**「配置要确认」两个理由任一——把流式切片收到的那个 `Set` 换成一个新空集（等于取消判定彻底失效）33 条用例全绿。补了一条 `confirm_edit: false` 的同类用例，只剩轮次登记这一个理由能拦住，同一变异现在恰好红这一条。产品代码没动。
- 三条变异核验（跑完逐字节还原，`diff` 与变异前一致）：`stop` 里不打轮号标记 → 4 红（新增那条 + 检索阶段停止 + 停止后不再执行剩余检索 + 停止后立刻重新提问）；`runStream` 收尾的 `turn.seq === turnId` 改成恒真 → 1 红（旧循环把新轮的 streaming 拆掉那条）；上面那个空集注入 → 1 红（新增那条）。三次各红在各自管的那条接缝上。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 97 文件 / 1,300 通过（+1）、`npm run format:check` 干净、`npm run build` exit 0、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 本批没跑真机——动的是 store 内部编排，`send` / `stop` 的签名与调用点一字未改，用例那 89 条是桩流式（`aiChat` 被 mock），原生窗口里的真实流式与 `aiCancel` 这轮没复验。② `send` / `retry` / `regenerate` / `resend` / `quickAction` / `runQuickAction` / `continueGenerate` 这七条仍留在 `index.ts` 的返回对象里：它们只需要 `runStream` 与 `set` / `get`，下一批可以整体搬进 run 切片，`index.ts` 会只剩状态默认值与切片组装。③ 新增那条用例覆盖的是「done 迟到」这一条取消路径；「检索进行到一半被停、随后的 done 又带编辑指令」这个组合仍未覆盖。④ 被停轮号还是在 `runStream` 的 finally 里出队（与原实现同位置同写法），也就是说如果那一轮的 finally 没跑到（进程被杀这类），轮号会留在集合里；本批没有改这个口径。

### 工程：AI 的八条动作与 agent 循环合成 `run-slice.ts`（`stores/ai/index.ts` 428 → 99 行）

- 搬动：`send` / `retry` / `quickAction` / `runQuickAction` / `continueGenerate` / `regenerate` / `resend` 七条（144 行）连同模块级 helper `currentPageRef`（6 行）搬进 `run-slice.ts`；`runStream` 由「切片对外返回」改成切片私有，`AiRunActions` 换成 `Pick<AiState, 那八条>`，`index.ts` 里那行解构改成 `...createRunSlice(set, get, {…})` 展开——与 config / panel / session / message 四片同形制。
- 字节审计：搬的 150 行与 `git show HEAD:src/stores/ai/index.ts` 里的原实现**逐行相同、0 处差异**（H 批那 8 处标识符替换只落在循环与 `stop` 上，这七条本来就没动过）。
- `index.ts` 现在只剩「装配五组切片 + 给状态初值 + 对外 re-export」，`create` 闭包里一个可变量都不留（轮次那三个值在 `turn-registry.ts`）；随之删掉 7 条只服务于动作实现的 import（`toast` / `newId` / `getAiEditor` / `flattenTree` / `useWorkspaceStore` / `t` / `QUICK_PROMPT_KEY`）。
- 搬的过程挖出两处**搬了等于没验**的洞，各补了用例（产品代码没动）：① `quickAction` / `runQuickAction` / `continueGenerate` 在整个 AI store 用例里一次都没被调用过（`grep` 三条名字为零），而 `quickAction` 恰好是这批新要用注入读数 `maxChars` 的那条——补 4 条：总结取整页并按 `max_chars` 截断、续写没有编辑器桥时提示且不发请求、自定义指令的 `{content}` 替换、继续生成的两道守卫。② 把 `send` 里的 `pageRef` 写死成 `null`（来源页标注彻底失效）时 `ai-session` 那 33 条全绿——那条 `sessionPageId` 断言走的是 `loadSessions` 从库里读 `page_id`，与 `send` 当时的标注无关；补了一条「首条提问标注所在页面、之后的提问不改标」。
- 夹具的坑记在这里免得再踩：用例里换 `getAiEditor` 的桩要 `{ ...M.bridge, getPageText: … }` 这样展开，只给一个方法会让 `requestMessages` 组装上下文时抛错，表现成「`aiChat` 一次都没被调用」，看着像动作没生效，其实请求根本没发出去。
- 三条变异核验（跑完逐字节还原，`diff` 与变异前一致）：`send` 去掉先行落盘 → 1 红（「结束后按条落库」盯 `aiSessionSave` 两次）；总结不截断（`page.slice(0, limit)` 换成 `page`）→ 1 红（新增那条）；`pageRef` 写死 `null` → 1 红（新增那条标注用例）。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 97 文件 / 1,305 通过（+5）、`npm run format:check` 干净、`npm run build` exit 0（59.27s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 真机仍未跑——八条动作在 `AiState` 上的签名与界面调用点一字未改，但快捷动作在原生窗口里点出来的效果这轮没复验。② `regenerate` / `resend` 的守卫分支（最后一条不是 user、找不到那条消息）与 `quickAction` 的 translate / rewrite / explain 三条（共用同一段选中文本代码）仍只覆盖主干。③ `runStream` 对外可见性没变（它本来就不在 `AiState` 上，只是从 index 的闭包局部挪进切片局部），但以后若要有「整段重跑」这类入口，得再显式暴露一次。

### 工程：`AiPanel.tsx` 的历史会话弹层与输入区切出两个组件（968 → 548 行）

- 搬动：历史会话弹层（遮罩 + 搜索框 + 「进行中 / 已归档」两个分区 + 每行的改名 / 归档 / 删除）切出 `SessionHistoryPopover.tsx`（151 行），输入区（附件条、@ 引用下拉、优化提问候选、编辑器带入的选中内容、发送 / 停止按钮）切出 `AiComposer.tsx`（332 行）。`AiPanel.tsx` 随之从 968 行降到 548 行（+21 / −441），只剩面板外壳、消息列表与两个挂载点，14 个只服务于这两块的 import 符号（`ImagePlus` / `Send` / `Square` / `viewIcon` / `MAX_AI_IMAGES` / `saveAiImageFile` / `filesFromDataTransfer` / `ai-mention` 整行 / `flattenTree` / `parseViewAliases` / `cn` / `ImageThumb` / `AI_IMAGE_ACCEPT` / `AiImageAttachment`）与 4 个弹层图标（`Archive` / `ArchiveRestore` / `Search` / `Trash2`）一起搬走。
- 边界按「谁跨边界」定：两块对外都只留真正需要的口子。弹层只有 `onClose`（收起要改宿主的 `showHistory`）与 `onRequestDelete`（删除要过宿主的确认框）两个回调，六条 store 读数与五个动作在它自己里面取；输入区因为 `textareaRef`（唤起时 focus）、`fillInput`（快捷动作把提示词填回）、`setPinned`（发送后把消息列表拉回底部）都归宿主，走的是 state / setter / ref 下传，`mention` 的行内对象类型顺手提成共用 `interface AiMention`——宿主 `fillInput` 也要清它，原来就是两处重复。
- 字节审计（新文件里每行去掉缩进后必须逐字出现在 `git show HEAD:src/features/ai/AiPanel.tsx`，不匹配的只允许是显式改写的行）：`SessionHistoryPopover.tsx` 87 行逐字来自 HEAD、11 行不匹配（2 行 props 声明、4 行摘掉 `showHistory ? … : []` 守卫的派生、1 行 `onClose()`、1 行 `onRequestDelete`、3 行 prettier 合行）；`AiComposer.tsx` 194 行逐字来自 HEAD、19 行不匹配（14 行 props 类型与解构、3 行 `AiMention` 接口、2 行 prettier 合行）。搬移体一律用脚本做统一 dedent + 逐区间取原文，不手抄。
- 新增 15 条 jsdom 用例（`SessionHistoryPopover.test.tsx` 7 条、`AiComposer.test.tsx` 8 条），这两块此前只能靠肉眼在原生窗口里看：搜索按标题与正文筛、分区页签的计数是全量而列表只露当前分区、点会话名切过去并收起、改名的 Enter / Escape、删除只把 id 递给宿主而组件自己不碰会话数据、归档按当前取反下发、「加载更多」只在超出显示窗口且非归档区时出现；输入区则钉住 Enter 发送走 `send(text, undefined)` 并清空 + 拉回底部、Shift+Enter 只换行、空输入且无附件时禁用、改提问态走 `resend` 与 `cancelEdit`、流式中换成停止、@ 引用候选来自页面树且方向键挪高亮 / Enter 选中写回「@名称 」（末尾空格进输入框但不进请求，发送前 `trim`）、优化提问候选点一条填回并清空候选、带入的选中内容显示条数且清掉走宿主的 `setPendingContext(null)`。
- 四条变异核验（跑完逐字节还原，`grep` 确认四处原样回来了）：点会话名不再收起 → 1 红；`historyList` 绕过筛选函数 → 2 红（搜索 + 分区）；发送不再 `setPinned(true)` → 1 红；@ 引用选中时不补尾随空格 → 1 红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 99 文件 / 1,320 通过（+15）、`npm run format:check` 干净、`npm run build` exit 0（55.89s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 真机没复验——两块挂在同一个位置、props 全是原宿主的变量，界面观感这轮只在 jsdom 里看过。② `AiComposer` 里图片附件的落盘（`saveAiImageFile`）与粘贴取文件（`filesFromDataTransfer`）只测到「被调用」，没测真写进 `assets/`；③ 输入区 12 条 store 读数仍是组件自取，`AiPanel` 那边同名读数已经删干净，若以后要在面板层读同一个值，得注意别读成两份快照。

### 工程：`GridView.tsx` 的表头行切出 `GridHeaderRow.tsx`（1,120 → 933 行）

- 搬动：整段 `<thead>`（131 行）连同只服务它的**三个状态**（重命名进行中、字段菜单开给谁、拖拽中的列）与**三个动作**（列宽拖拽 `startColumnResize`、排序循环 `cycleSort`、字段拖落 `onFieldDrop`）一起切出 `GridHeaderRow.tsx`（217 行）。宿主 1,120 → 933 行（+15 / −202），`CheckSquare` / `Square` / `GripVertical` / `FieldMenu` / `AddFieldButton` / `RenameInput` / `needsFieldSettings` / `clampColumnWidth` / `SortSpec` / `ReactMouseEvent` 十个 import 符号与 `sorts` 这条读数一起搬走。
- 边界按「谁跨边界」定：全选按钮走 `onToggleSelectAll`（勾了哪些行归宿主），字段设置弹层走 `onConfigure`（弹层本体在宿主，改完关联/公式类型也要用它），`<table>` 的 ref 也归宿主下传——列宽拖拽按 `fieldId` 找 `<col>` 改宽度，而 `<colgroup>` 留在宿主；`fields` / `sorts` 与七条字段动作由组件自己从 `useDbStore()` 取（与宿主同一份 Context 实例，不是第二份快照）。
- 字节审计：`GridHeaderRow.tsx` 179 行逐字来自 `git show HEAD:src/features/database/GridView.tsx`、34 行不匹配（4 行头注释、9 行 import、11 行 props 声明、6 行函数签名与解构、1 行 `const { fields, sorts } = store`、4 行标识符改写 `toggleSelectAll`→`onToggleSelectAll` 与 `setOptionsEditorFor`→`onConfigure`、3 行 prettier 合行）。搬移体仍用脚本做「统一 dedent + 逐区间取原文」。
- 新增 `GridHeaderRow.test.tsx`（288 行 / 12 条 jsdom 用例），钉住这五件以前只能在原生窗口里肉眼验的事：全选按钮只递动作给宿主且勾选态只换图标、排序循环「追加升序 → 转降序 → 取消」并且双列排序时第二列显示次序号、双击才开该列菜单且主列不可拖不可标 primary、菜单里的删除/隐藏各自打到 store 并顺手关菜单、重命名的 Enter 落库 / Escape 不落库 / 同名不写库、改成关联类才接着打开字段设置（普通类型不打开）、列宽拖拽「拖动只改 `<col>`、松手才落一次库、越界夹到 600、落库失败撤掉预览宽度并出声」、拖列换序把隐藏列一起带进重排（漏了就等于从 `store.fields` 里剔掉它）。
- 三条变异核验（跑完逐字节还原）：`onFieldDrop` 的 `sortable` 从 `fields` 换成 `visibleFields` → 1 红（拖列换序那条，正是代码注释里点名的风险）；升序点击后不转降序 → 1 红（排序循环）；松手落库落成起始宽度 → 1 红（列宽拖拽）。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 100 文件 / 1,332 通过（+12）、`npm run format:check` 干净、`npm run build` exit 0（48.59s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 真机没复验——表头挂在原位置、`data-testid="resize-*"` 与冻结主列的 sticky 层级都没改，但拖列宽与拖列换序在原生窗口里的手感这轮没复验（jsdom 量不出真实列宽）。② `AddFieldButton` 仍在组件里渲染但没有用例覆盖它（它自己走 `store.addField`，属另一条链）。③ 用例把 `FieldMenu` 替成了 stub（它有自己的 radix 菜单用例），所以「双击 → 菜单里真点一条」在组件层是断言 props 传递，不是断言菜单弹层真出现。

### 工程：`EditorPage.tsx` 的 AI 桥接切出 `ai-bridge.ts`（1,076 → 906 行）

- 搬动：宿主那段 172 行的 `useEffect` 体（`toSlice` / `topBlocks` / `locateHeadingSection` / `locateTextRange` 四个 helper 加桥的 11 个方法）搬进 `createAiEditorBridge({ editor, viewName })`；`registerAiEditor` / `registerAiEditorForView` 的登记、卸载闭包与依赖数组仍留在宿主，形制对齐 `grid-io-slice.ts`。
- 边界：桥只吃两个输入（编辑器实例与页面名），不碰 store，所以 AI 面板侧 `getAiEditor()` 与各条动作的调用点一字未改。唯一标识符改写是 `getPageTitle`：原来读闭包里的 `view.name`，现在读入参 `viewName`。
- 字节审计：新文件 192 行里 **175 行逐字**能在 `git show HEAD:src/features/editor/EditorPage.tsx` 中找到，另 15 行是 3 行头注释、4 行 import、接口与函数签名 5 行、`return bridge;`，以及被 prettier 合成一行的 `getPageText`。
- 用例：新增 `ai-bridge.test.ts` 29 条（读侧 / 回填侧 / 定位侧 / 改写侧 / 撤销侧 / 边界），这段逻辑第一次能脱离整页渲染被单独驱动。夹具是真 schema（`getSchema([StarterKit])`）+ 真 `EditorState` + `prosemirror-history`，只把 DOM 侧的 `view` 换成会记账的假件，`STRUCTURE_SYNC_META` 这类元信息就断在记下来的事务上。
- 夹具的坑记在这里免得再踩：① prosemirror-history 按 `tr.time`（取自 `Date.now()`）把相邻输入并成一个可撤事件，真实时钟下「AI 改完用户又编辑」会被并成一步、撤掉的正好是整体，`undoAiEdit` 直接返回 `true`，那条最要紧的守卫根本走不到——用例用假时钟跨过 500ms 的 `newGroupDelay` 才分得开组。② `toSlice` 返回 null 的退化分支靠夹具 schema 里没有 `mention` 节点触发：`@[报表](view:123)` 会让 `PMNode.fromJSON` 抛错。③ tsconfig 的 lib 里没有 `Array.prototype.at`，取末元素得自己写 helper。
- 六条变异核验（跑完逐字节还原，`diff` 与变异前一致）：去掉 `sec.index === 0` 守卫 → 1 红；`revert` 存成改后快照 → 3 红（撤销链路整体失配）；兜底写回不带 `STRUCTURE_SYNC_META` → 1 红；去掉 `hit.index === 0` 守卫 → 1 红；`insert_under_heading` 的落点从 `sec.end` 挪到 `sec.start` → 1 红；锚点标题不去 markdown 记号 → 1 红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`vitest run` 101 文件 / 1,361 通过（+29）、`npm run format:check` 干净、`npm run build` exit 0（54.26s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `ai.locateBlockedByLock`（结构锁 `filterTransaction` 拒掉事务后据实回报）这条分支假件里没有对应物——假 `view.dispatch` 从不拒收事务，要覆盖它得连真 `DocumentStructureLock` 插件一起挂上，而真插件又要求真 `view`；这条只能在原生窗口里靠「让 AI 改标题行」验，本轮没验。② `replace_text` 跨顶层块的匹配（设计上宁可失败）与 `undoAiEdit` 的「撤销栈被清空」极端路径仍只覆盖主干。③ 整轮没跑真机：桥的方法签名没变，但 AI 面板就地改文档在原生窗口里这轮没复验。

### 工程：`lib/ai-tools.ts` 按职责拆成目录模块（754 行 → 单文件最大 175 行）

- 搬动：AI 的工具执行层从单个 `src/lib/ai-tools.ts` 拆成 `src/lib/ai-tools/` 九个文件——`resolve-page`（页面引用解析，28）、`retrieval`（五个只读取证工具与 6000 字截断，155）、`write-page`（建页 / 改名，81）、`write-rows`（加行 / 改行 / 删行与行引用解析，175）、`write-dispatch`（`WriteCall` 与分发，35）、`undo-plan`（`UndoPlan` / `WriteOutcome` / `sanitizeUndoPlan` / `runUndoPlan`，118）、`cell-coerce`（模型给的值 → 字段类型能存的值，85）、`specs`（喂给模型的 11 条工具定义表，129）、`index.ts`（23 行，逐字沿用原文件的域头注释 + 只做 re-export）。对外符号面拆前拆后一致：`coerceCell` / `resolvePage` / `runRetrievalCall` / `runUndoPlan` / `sanitizeUndoPlan` / `UndoPlan` / `WriteOutcome` / `aiToolSpecs` / `runWriteAction` / `WriteCall`。
- 「纯移动」的证明是引用方零改动：`stores/ai` 的六处 import（`edit-ops` / `message-slice` / `run-slice` / `session-codec` / `stream-slice` / `types`）与 `features/ai` 一字未动，`@/lib/ai-tools` 与 `./ai-tools` 两个 import 源都还命中——因为目录里有 `index.ts`。`git status` 只有「原文件删除 + 目录新增 + 测试文件改动」三类。`vi.mock("./database")` 从 `src/lib/ai-tools.test.ts` 仍作用于 `ai-tools/../database`，vitest 按解析后的绝对模块 id 匹配，测试的替身机制也没改。
- 只有三类非逐字节改动：① 九份文件头注释与按需 import（原来 14 行共享 import 摊成 44 行，路径由 `./x` 变 `../x`）；② 五个写动作函数加 `export`（`write-dispatch` 跨文件要调它们；`index.ts` 不 re-export，对外可见性不变）；③ 加 `export` 后两条签名超行宽被 prettier 拆成多行。字节审计（新文件每行去缩进后必须逐字出现在 `git show HEAD:src/lib/ai-tools.ts`）：714 行逐字命中、79 行属于上面三类；反向查 HEAD 的 729 个非空行，未被搬走的 19 行 = 14 行旧 import + 5 行加 `export` 的签名，没有漏搬。
- 用例：`ai-tools.test.ts` 19 → 22 条，新增「拆文件后的三条接缝」——撤销 `reset_cells` 也要发 `onDatabaseChanged` 并失效 relation 缓存（原来只有加行走这条，删行/改行的通知各自有测，撤销链没有）、`runRetrievalCall` 在 250 页的长树下确实截断到 6000 字以内（`renderTree` 的 limit 与 `truncate` 的 limit 是两层，谁都得真的生效一次）、`aiToolSpecs()` 的名称集合就是那 11 条且每条形状完整（拆文件时 `TOOL_DEFS` 与 `aiToolSpecs` 分家，漏一条模型就少一个动作且没有任何报错）。
- 六条变异核验（跑完逐字节还原，`diff` 与变异前一致）：分发层删掉 `delete_database_row` case → 1 红；数字强赋去掉「一个数字都没有」的判空（`Number("")` 是 0，会把「待定」静默写成零）→ 1 红；`resolvePage` 同名多页时改为返回第一个 → 1 红；撤销 `reset_cells` 不发通知 → 补测前 0 红 / 补测后 1 红；`runRetrievalCall` 不截断 → 补测前 0 红 / 补测后 1 红；`TOOL_DEFS` 少一条 → 补测前 0 红 / 补测后 1 红。后三条正是这次拆文件能碰坏的地方，所以补测是为它们补的。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,364 通过（+3）、`npm run build` exit 0（55.28s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `runRetrievalTool` 的 `search_workspace` / `get_page_content` / `list_database_fields` / `query_database` 四条只有「返回什么文案」的粗断言，喂回模型的正文（命中行格式、字段选项串、表头行）没有逐条钉住；`get_page_content` 空文档的兜底文案同样未覆盖。② 本轮没跑真机：AI 面板走一遍取证与写卡片要在 `npm run tauri dev` 原生窗口里看，浏览器打开必白屏。③ 禁区按约不动：恢复会话时刻意不还原 `apply_edit` 的 revert 句柄，现在写在 `stores/ai/session-codec.ts:80`（项目卡上的 `stores/ai.ts:330` 已随 I 批迁移），只记不改。

### 工程：`lib/ai.ts` 按职责拆成目录模块（443 行 → 单文件最大 143 行）

- 搬动：AI 与 Rust 的 invoke 封装从单个 `src/lib/ai.ts` 拆成 `src/lib/ai/` 八个文件——`types`（对话契约：消息 / 工具调用 / 流式事件 / 用量，49 行）、`profile`（档位与服务商预设，68 行）、`config`（`AiConfig` + 读写与连接测试四个命令，143 行）、`image`（视觉输入：白名单、上限、压缩、落盘，93 行）、`session`（会话行与三条 CRUD，34 行）、`usage`（用量汇总与成本口径，35 行）、`request`（流式对话、取消、片段检索、错误文案，37 行）、`index.ts`（20 行：域头注释逐字沿用 + 12 行 re-export）。对外 36 个符号（22 个值 + 14 个类型）拆前拆后一致。
- 「纯移动」的证明同样是引用方零改动：25 个引用点一字未改——22 个文件 `from "@/lib/ai"`（`features/ai` 3、`features/settings` 2、`stores/ai/*` 12、`stores/ai-*.test.ts` 3、`test/ai-store-harness.ts` 与 `test/tauri-mock.test.ts` 各 1）、`lib/ai-tools/` 里 2 处 `from "../ai"`，再加 `ai.test.ts` 自己的 `"./ai"`。其中三处 stores 用例与 harness 是整模块 `vi.mock("@/lib/ai", …)` 替身，按解析后的绝对模块 id 匹配，换成目录 index 后照样拦得住。`git status` 里产品代码只有「原文件 D + 目录 ??」两类加一个测试文件。原文件的三条 import 按需落到各文件、路径仍用 `@/lib/...` 别名，所以它们逐字命中 HEAD 而没被改写。
- 只有两类非逐字节改动：8 份文件头注释与 4 行新增的 per-file import（`config` 要 `./profile` 的两个档位类型、`request` 要 `./types` 的三个契约类型）、`index.ts` 的 3 行目录说明与 12 行 re-export。字节审计：406 行逐字命中 `git show HEAD:src/lib/ai.ts`、27 行属于这两类；反向查 HEAD 的非空行，**未被搬走的 0 行**（一个字符都没丢，也没有归类不明的行）。
- 用例：`ai.test.ts` 16 → 26 条。原先这 443 行里只有图片附件、`aiSaveConfig` 的 snake_case 下发与成本换算有断言，`aiChat` 与三条会话命令、`docSearchSnippets` 一次都没被测过——拆文件恰好把它们的接缝露出来：Channel 替身改成会自登记的实例，补「不带 tools 时下发 `tools: null`」「`onEvent` 挂的是 `onEvent` 这个参数名」「服务端帧从 `channel.onmessage` 透回上层回调」「删会话走 `{ id }` 不是 `{ sessionId }`」「片段检索的 `viewId` 用 camelCase 且 `limit` 默认 8」「六条单行转调壳各自打对自己的命令名」「`aiErrorText` 的三种抛法」。再加一条运行时符号面守卫：`Object.keys(import * as ai)` 必须正好是那 22 个值导出。
- 顺手补了拆文件前就存在的两个断言洞：`downscaleImage` 的真实缩放主路径以前从没跑过（默认 node 环境里 `createImageBitmap` 不存在，三条用例全走在「解码失败退回原字节」的兜底上），文件切到 jsdom 后替出解码与重编码的最小形状，钉住「3000×2000 夹到 1568×1045、入库的是重编码后的字节」与「重编码反而更大就保留原始字节」——这两条只在真浏览器里成立的分支现在是断言得动的。
- 九条变异核验（跑完逐字节还原，脚本对每个文件断言还原后与原内容一致）：index 少 re-export 一个当前无人使用的值导出（`AI_IMAGE_MIME_BY_EXT`）→ 符号面用例红，**且 `tsc --noEmit` 全绿**（这正是那条用例存在的理由：漏一行导出、等以后有人用时才发现）；`tools ?? null` 改成 `tools` → 1 红；不把回调挂到 `channel.onmessage` → 1 红；片段检索默认 `limit` 8 改 5 → 1 红；`{ id }` 改 `{ sessionId: id }` → 1 红；`AI_PRICE_PER_MILLION` 从 100 万改 1 千 → 3 红（口径用例 + 两条换算用例）；`ai_list_models` 写错成 `ai_models_list` → 1 红；边长上限 1568 改 784 → 1 红；去掉「重编码更大就不换」的守卫 → 1 红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,374 通过（+10）、`npm run build` exit 0（49.03s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 图片附件的 `MAX_AI_IMAGES`（一条消息最多 4 张）由 `AiComposer` 消费，本批没动它也没有针对它的断言（超限拦截在组件层，属 `features/ai` 的用例面）。② `aiChat` 的真机帧序与 `aiCancel` 的生效仍只能在原生窗口里对着服务商接口验；本批把 `downscaleImage` 的解码路径搬进 jsdom 替身，替身给的是「一定解码成功」的形状，真机上「解码失败退回原字节」这条已有用例覆盖、但「真实缩放的画质损失」无从断言。③ 本轮没跑真机，也没写库数据（开发库是真实数据，冒烟只许读）。

### 工程：只服务 AI 面板渲染的两个 lib 模块下沉进 `features/ai`

- 搬动：`src/lib/ai-citation.ts`（95 行）与 `src/lib/ai-math.ts`（101 行）连同各自用例（109 / 79 行）搬进 `src/features/ai/`，`Markdown.tsx:10-11` 的 import 源由 `@/lib/…` 换成 `./…`，符号名与路径别名 `@/lib/i18n`、`@/lib/app-context` 那些都不受影响。这两个模块只做「答案正文里的 `[id=…]` 变可点链接」「`$…$` 变 KaTeX 占位节点」，全仓唯一消费点就是 AI 面板的 Markdown 渲染；留在 lib 会让人以为别的域也能用。
- 为什么只搬这两个：AI 域散在 lib 的其余模块确实被跨域共用——`katex-render` 由 `features/ai` 与 `features/editor` 同用、`code-highlight` 4 个消费点跨两域、`ai-editor` 7 处、`ai-edit` 8 处、`ai-locate` 5 处、`ai-mention` 2 处，按「公共的留 lib」一律不动。
- 「纯移动」的证明：四个文件与 `git show HEAD:src/lib/<同名文件>` 逐字节对齐，总差异 5 行——两个用例各 1 行 import 源、两条「为什么放在 feature」的头注释、1 行把旧注释里的 `lib/ai-citation` 写成 `./ai-citation`（模块自己的位置变了，不改会指错）。`Markdown.tsx` 的 `git diff --stat` 只有 4 ++--。
- 七条变异核验（跑完逐字节还原并断言一致）：`MATH_NODE_TYPE` 改名 → 7 红；`CITED_ID_RE` 去掉首尾锚点 → 1 红；引用标记正则去掉右括号 → 3 红；`transformMath` 的 `includes("$")` 改成 `"$$"` → 2 红；`Markdown.tsx` 的两处 import 指回已删除的 `@/lib/…` → `tsc` 报 TS2307（证明 lib 里的副本真的没了、不存在两份真值）。
- 顺手补了一个搬迁前就存在的断言洞：行内公式规则里「闭合 `$` 后是数字就不算公式」这条负向前瞻原本去掉后 10 条用例全绿——补「共 $x$2 个」把它钉住（`ai-math.test.ts` 10 → 11 条）。核对时还确认旧注释的说法不准：`要 $100 和 $200` 实际是被「闭合 `$` 前是空白」挡下的，数字前瞻管的是 `$x$2` 这种形态；注释属文案订正，本批没改。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,375 通过（+1）、`npm run build` exit 0（50.92s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `lib/ai-tokens.ts`（40 行，估 token）唯一消费点是 `stores/ai/request-slice.ts`，按「公共状态留 stores」的口径它归 lib 还是归 stores 都没错，本批没定。② `Markdown.tsx:155` 认的是字面量 `"ai-math-block"` 而不是同目录的 `MATH_CLASS_BLOCK` 常量——现在两者挨在一起，改常量不改字面量会静默错版，属一致性/行为另案。③ 引用点击跳转与公式排版只能在 `npm run tauri dev` 的原生窗口里看，本批未跑真机。

### 工程：AI 取证工具喂给模型的正文有断言盯着了（产品代码零改动）

- `runRetrievalTool` 的四条只读取证分支此前只有「返回了字符串」级别的断言，而它的返回值是原样喂回模型的正文——格式改坏不会报错，只会让模型下一步答得离谱。补 6 条用例钉住：命中行 `- 标题 [id=页面 id] (布局)：片段`（`<em>` 标记与换行不进上下文、单条片段 200 字封顶、最多列 12 条但计数说的是全部命中）；字段清单过滤隐藏列、选择类带上「（选项：待办 / 进行中）」；表数据首列是行 id（模型改/删行时唯一的凭据），新建还没写格子的行按空列走而不是整条检索抛错；正文超长时先按片段召回（`docSearchSnippets(页面, 问题, 8)`）、片段空手才退回硬截断，没给问题就根本不查片段；空正文、坏 JSON、只有空白都回「「x」还没有正文。」；三条拒绝文案（没关键词 / 没打开空间 / 不认识的工具名）。
- 用例面：`src/lib/ai-tools.test.ts` 22 → 28 条。原来的 `documentApi` 替身写死「正文恒为 null」，换成可当场摆正文的 `docs.get`，另加 `searchApi.search` 与 `docSearchSnippets` 两个替身；产品代码一行没动（`git diff --stat` 只有这一个文件）。
- 17 条变异核验（每次改坏 `retrieval.ts` 的一处 → 跑用例 → 逐字节还原并断言一致）：命中行去掉 id、只剥 `<em>` 开标签、清单从 12 条放宽、选项串分隔符去空格、隐藏列进正文、表头首列换文案、缺 cell 的行不兜底、行数不按 30 封顶、空正文不回兜底、超长不走片段召回、片段条数 8 改 5、行详情页混进检索清单、片段上限 200 改 400、没关键词也打搜索、零命中回「检索到 0 个结果」、不认识的工具回空串、没空间也打搜索——17 条全部转红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,381 通过（+6）、`npm run build` exit 0（52.72s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `get_page_content` 的正文形态走的是真 `jsonToMarkdown`，用例喂的是「一个段落一行文本」的最小文档，列表 / 代码块 / 表格转出的 Markdown 长什么样仍无断言（那是 `lib/markdown` 的用例面）。② 命中顺序与权重来自 Rust 侧的 `doc_search`，前端只钉住「拿到什么就格式化成什么」。③ 本轮没跑真机。

### 工程：AI 设置页按 JSX 边界切成三个子件（`SettingsAi.tsx` 749 行 → 父级 357 行）

- 搬动：`src/features/settings/SettingsAi.tsx` 里三块成形的编辑区切出去——`SettingsAiTuning.tsx`（198 行：采样参数、思考模式、上下文范围、网络与 agent 调优、自定义系统提示）、`SettingsAiProfiles.tsx`（179 行：模型档位的增删改）、`SettingsAiQuickActions.tsx`（105 行：自定义快捷指令的增删改）。父级留下服务商/协议/模型/Key 的连接区与整份配置的读写编排（`applyAiConfig` / `persistAi` / `saveAi` / `testAi` / `fetchModels`）。
- 两个模块私有常量 `AI_NUM_INPUT` / `AI_TEXT_INPUT` 一并搬进 `settings-parts.tsx` 并加 `export`（三块共用，父件搬完一行都不再引用）；档位与快捷指令的六个动作函数（`addProfile` / `removeProfile` / `addQuickAction` / `updateQuickAction` / `removeQuickAction` 及其 `// — 模型档位 —`、`// — 自定义快捷指令 —` 两行分节注释）跟着各自的 UI 落到子件里，位置没变、内容没改。
- 「纯移动」的证明有两条。① 引用方零改动：全仓唯一引用点 `SettingsPage.tsx:16` 的 `from "./SettingsAi"` 与 `:57` 的 `<SettingsAi />` 一字未动，导出符号仍只有 `SettingsAi`。② 字节审计：切出去的 396 行（调优 176、档位 JSX 124 + 动作 17、快捷指令 JSX 63 + 动作 16）在子件里与 `git show HEAD:src/features/settings/SettingsAi.tsx` **整段逐字节相同、含缩进**——父级 JSX 在 `<Section>` 下是 6 空格，子件在 `return (<>…` 下也是 6 空格，所以这次连 dedent 都不需要；反向对四个改动文件做行级归类，未归类行 0。
- 子件是纯受控展示件，保存仍归父级：`ai_save_config` 是覆盖式整份保存，表单值一旦分成两份真值就会互相冲掉。档位 Key 草稿 `profileKeys` 与 `aiConfig` 必须由父级传入——`persistAi` 要按档位 id 判「草稿留空 = 不改该档已存 Key」，把草稿下放到子件等于把这条规则拆断。
- 用例：`SettingsAi.test.tsx` 3 → 16 条（+321 行）。拆文件把三处没人盯的接缝变成真接缝，逐条钉住：调优侧「温度改完离开输入框整份落库、其余采样字段原样带回」「系统提示只在 blur 时落库（边打字边存要红）」「思考模式与上下文范围两个下拉各自只改自己那一项」；档位侧「地址/模型/温度/协议四格回填」「改模型后落库的档位数组必须正好是那七项——`has_api_key` / 掩码泄进 IPC 入参就是往服务端写脏字段」「Key 草稿留空传 null、填了才覆盖、落库后草稿作废，掩码文案与明文警告都跟着 `aiConfig`」「删当前档 active 收回、删非当前档 active 不动」「新档继承当前地址/模型/温度」；快捷指令侧「三格回填」「改作用范围即时落库并带回整份数组」「新增的空壳默认只吃选区」「删除收回空数组」。夹具里把 `AI_PROTOCOL_OPTIONS` 的替身从 `[]` 换成四条真值，档位协议下拉的选中值才进得了断言。
- 十条变异核验（每次改坏一处 → 跑用例 → 逐字节还原并断言与变异前一致）：父级把 `profileKeys` 接成 `{}` → 1 红；把 `aiConfig` 接成 `null` → 1 红；子件丢掉系统提示的 `onBlur` 保存 → 1 红；思考模式下拉接到 `ctxScope` → 1 红；档位 Key 输入框不读草稿（恒空） → 1 红；删档位恒把 `activeProfile` 收回 → 1 红；加档位不再继承 `base_url` → 1 红；快捷指令下拉把 scope 接到 name → 1 红；删指令不再带回数组 → 1 红；保存时 `...p` 整份铺开档位对象 → 1 红。十条各自只打死预期的那一条，没有互相误伤。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,394 通过（+13）、`npm run build` exit 0（54.35s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 父级留下的连接区（服务商预设切换、`testAi` / `fetchModels` 两个按钮、全局 Base URL 与 Key、`maxChars` / `confirmEdit` / `useTools`）搬迁前后都没有直接用例，本批只通过「改调优字段 → 整份保存」间接带到过 `apiKey: null` 与 `maxChars`；要钉它们得再往这个文件里加渲染用例，属另批。② 三个子件的界面只在 jsdom 里渲染验证过，档位下拉的真机选项文案与 `dark:` 配色没在 `npm run tauri dev` 的原生窗口复验。③ 两个样式常量现住在 `settings-parts.tsx`，那是「部件」文件而它们只是字符串；原注释写的是「档位与快捷指令」，随三块共用改成了「调优、档位与快捷指令三块」。④ 子件接了 `setAiForm` / `setProfileKeys` 两个 setter，是搬迁的最小代价；按项目卡的 MVVM 方向将来该把保存下沉一层，本批不夹带。

### 工程：AI 动作协议从单文件拆成四个职责文件（`lib/ai-edit.ts` 429 行 → 目录模块）

- 搬动：`src/lib/ai-edit.ts`（429 行，AI 域剩下的最大一个前端单体）按职责切成 `src/lib/ai-edit/` 目录模块——`types.ts`（78 行，原 8-83：`AiCall` 六种动作的形状、`AiEditOp` 七个 op、`RETRIEVAL_TOOLS` / `WRITE_TOOLS` 两组名单、两个代码块标记）、`protocol.ts`（110 行，原 87-192：`PROTOCOL` 正文与三种上下文范围的说明、`buildEditSystemPrompt` / `buildNoContextSystemPrompt` / `CHAT_ONLY_SYSTEM_PROMPT` / `retrievalResultMessage`）、`validate.ts`（103 行，原 194-285：`validateCall` 与三个私有收窄助手）、`extract.ts`（150 行，原 85 的 `FENCE` + 287-429：`scanBlocks` / `stripBlocks` / `extractCalls` / `extractEdit` / `hideEditBlock`）、`index.ts`（23 行：沿用原文件头注释 + 手写 re-export）。
- 「纯移动」的证明有两条。① 引用方零改动：12 个 import 点（`ai-editor.ts`、`ai-locate.ts`、`stores/ai/` 的 `calls` / `edit-ops` / `request-slice` / `run-slice` / `session-codec` / `stream-slice` / `types`、用例文件）的 `from "./ai-edit"` / `from "@/lib/ai-edit"` 一字未动，路径自己指向目录 index；对外符号面仍是 24 个（15 个值 + 9 个类型）。② 字节审计：四个正文文件共 417 行（76 + 106 + 92 + 143 含 `FENCE` 那一行）与 `git show HEAD:src/lib/ai-edit.ts` **整段逐字节相同、含缩进**——顶层声明本就都是 0 缩进，不需要 dedent；新增的 34 行全部归类为「四份文件头注释 + 按引用方向补的 import + index 的 re-export」，反向核对「HEAD 里没被搬走的行 = 0」。
- 用例：`src/lib/ai-edit.test.ts` 21 → 27 条。协议层那 6 个符号（`CHAT_ONLY_SYSTEM_PROMPT`、`buildNoContextSystemPrompt`、`CTX_SCOPE_PAGE_ONLY_NOTE`、`RETRIEVAL_BLOCKED_BY_SCOPE_NOTE`、`retrievalResultMessage`、`WRITE_TOOLS`）此前只被 `stores/ai/` 消费、一条断言都没有，拆分把它们变成有人盯的：补了「无文档时协议照常下发但不给当前页」「关闭上下文按有没有可编辑文档换说明段，两段互斥」「检索结果回灌要按工具分节带出正文」「『仅本页』说明点名全部 5 个检索工具」。
- 加了运行时符号面守卫（沿用 `ai.test.ts` 的做法）：`Object.keys(await import("./ai-edit"))` 必须正好是那 15 个值导出，另用一份九字段对象把 9 个类型导出各自引用一次。理由是 index 的 re-export 是手写的——漏一行而当下没人用那个符号，`tsc` 和原有 21 条用例都不会报。
- 断言口径也收紧扣了一遍：原来只写 `expect(p).toContain(EDIT_BLOCK_TAG)`，而 `"tsflowy-edits"` 这种硬编码假名包含 `"tsflowy-edit"`，照样绿；改成断言整行开栏 `"```" + EDIT_BLOCK_TAG + "\n"`，协议正文若把标记接错就立刻红。
- 十二条变异核验（每次改坏一处 → 跑检查 → 逐字节还原并断言与变异前一致）：index 漏 re-export 一个当下没人用的值（`AI_EDIT_OPS`）→ 值导出用例红；漏 `export type { AiEditContext }` → `tsc` 红（证明类型那侧的守卫靠编译期）；漏 `hideEditBlock` → 值导出用例红；协议正文里编辑块标记接成检索块标记 → 2 红；检索标记写成硬编码假名 → 1 红；`buildNoContextSystemPrompt` 两个分支接反 → 1 红；`retrievalResultMessage` 不再点名工具 → 1 红；`apply_edit` 不再要求 `content` → 1 红；默认分支不再认检索工具名 → 2 红；`scanBlocks` 只认编辑块 → 2 红；`stripBlocks` 不再压回段落间距 → 1 红；`hideEditBlock` 漏掉检索块 → 1 红。十二条全部转红且都点到了预期的用例。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,400 通过（+6）、`npm run build` exit 0（48.88s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① `FENCE` 那个常量现在只住在 `extract.ts`，而 `protocol.ts` 的协议正文里 ``` 是模板字符串中的字面量，两处不共用一个符号——这与拆分前一样，但分成两个文件后更容易被误读成「改 `FENCE` 就同时改协议」，实际只有取块那一侧跟着它走。② 新增符号要改三处（正文文件 + `index.ts` 的值导出行 + 值导出用例的名字数组），守卫只能保证「漏了会被发现」，不能让漏报变少。③ 用例文件仍是一个 `ai-edit.test.ts`（27 条），没跟着拆成四个：它测的是这套协议的整体对外行为，按文件拆反而要把块标记的夹具复制四遍。④ 本轮没跑真机。

### 工程：agent 循环从动作切片里切出 `run-stream.ts`（`run-slice.ts` 390 → 204 行）

- 搬动：`src/stores/ai/run-slice.ts` 里那段 154 行的 agent 循环（发请求 → 本机执行模型要的只读检索 → 把结果喂回下一轮 → 收敛后落地写动作）连它上面的 JSDoc 一起切进新文件 `src/stores/ai/run-stream.ts`（206 行）；切片只剩界面上的八条动作（send / stop / retry / 两条快捷动作 / 继续生成 / regenerate / resend）与 `currentPageRef`，204 行。
- 切这一刀的依据是注入清单的真实用量：原来那份 `AiRunDeps`（`turn` + 出请求切片 6 项 + 流式切片 3 项 + 落盘 1 项，共 11 项）**只有循环在用**，八条动作只用得到其中三项（`maxChars` / `persistSessions` / `turn`）。类型与 11 个名字整体搬进 `run-stream.ts` 并 `export`，切片签名改成 `(set, get, deps: AiRunDeps)`，把 `deps` 原样转发给 `createRunStream`——装配方 `src/stores/ai/index.ts:61-73` 那 12 行调用一字未动，`createRunSlice` 的对外形状也不变。
- 「纯移动」的证明：新文件套一层 `createRunStream(set, get, { …11 项 }): RunStream` 的工厂外壳，里面仍是 `const runStream = async (assistantId: string) => {` 的两格缩进，所以**循环体 154 行连缩进逐字节不变**（这是继 P5-5 的 JSX 之后第二次不需要 dedent）；八条动作 165 行、`currentPageRef` + `AiRunActions` 13 行同样整段逐字节命中；`AiRunDeps` 那五行只在一行前面加了 `export`，是本轮唯一的字符级改动。反向核对：390 行里没被搬走的只有 5 行（两份工厂签名、被拆成两条的那行 import、被改写的一行头注释），新增 21 行全部归类为「文件头注释 + 按引用方向拆开的 import + 外壳」。
- 十条变异核验（每次改坏一处 → 跑三个 AI store 用例文件 → 逐字节还原并断言与变异前一致）：循环收尾不再落盘 → 3 红；旧循环替新一轮拆掉 `streaming`（`turn.seq === turnId` 守卫失效）→ 1 红；检索步骤之间不再核对停止 → 1 红；超限不再降预算补发 → 1 红；到轮次上限仍继续执行检索 → 2 红；「仅本页」档不再拦检索 → 1 红；转发时把 `maxChars` 换成写死的 7 → 「文本协议检索块」红（截断上限真从注入的读数走到检索执行处）；转发时把 `finalizeAssistant` 换成空实现 → 多条写动作用例红；`send` 不再标注发起时所在页面 → 1 红；`stop` 标记了 `turn.seq + 1`（跨两个文件共享的那个 Set 接错）→ 「拦它的是轮次登记」红。
- 其中两条是踩出来才改对的：原本以为 `maxChars` 接错会打到「总结当前页」那条用例，实际红的是检索块那条——快捷动作走的切片自己解构的那份，循环走的是转发那份，正好证明两侧读数各管各的；`stop` 标错轮号在 `confirm_edit` 默认开着时看不出差别（两条路都停在待确认），只有那条关掉确认、专门盯轮次登记的用例红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,400 通过（用例数不变，纯移动）、`npm run build` exit 0（56.95s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① 循环与动作现在跨两个文件共享同一个 `TurnRegistry` 对象引用，靠变异 M2 / M3 / M10 三条盯住「读写的是同一份」；但类型层面给不了这个保证——注入方换成新建的 registry 也照样过编译。② 动作侧只解构三项，将来某条新动作要用 `ctxScope` 之类，得自己加进解构行；忘了加不会报错，只会拿不到值（`deps` 仍在手边，改起来是一行的事）。③ 两个文件的头注释现在互相指认（「循环在 run-stream.ts」/「八条动作在 run-slice.ts」），改一侧的分工描述要记得改另一侧。④ 没给 `run-stream.ts` 单开用例文件：94 条 AI store 用例继续从 store 的公开动作打进来，这正是纯移动的前提——真要单测循环本身，得先给它造一套比 store 装配更薄的夹具。⑤ 本轮没跑真机。

### 工程：token 估算跟着唯一的使用者搬进 stores/ai（P5 收口）

- 搬动：`src/lib/ai-tokens.ts`（40 行）→ `src/stores/ai/tokens.ts`，用例 `src/lib/ai-tokens.test.ts`（58 行）→ `src/stores/ai/tokens.test.ts`；git 认出两对改名（相似度 87% / 96%），内容改动只有三行头注释加两条 import 路径。
- 依据是引用面：全仓只有 `src/stores/ai/request-slice.ts` 一处用得上（截历史、截单条超预算的消息），估出来的数字也只服务于「这次请求带多少上下文」这一件事——属出请求那一层自己的口径，不是跨模块共享的 lib 能力。这与 P5-3 把两个渲染专属模块下沉 `features/ai` 是同一条规矩：代码住在用它的那一层；将来第二个模块也要估 token，再提回 lib。
- 这一刀之后，`src/lib` 里以 `ai-` 开头的顶层单体只剩三个真正跨层的：`ai-editor.ts`（编辑器桥的登记表，features/editor 与 stores/ai 两边都用）、`ai-locate.ts`（按标题/原文定位块，`edit-ops.ts` 与取证工具共用）、`ai-mention.ts`（@ 解析，编辑器的补全与出请求两侧都用）。
- 静态验证：`tsc --noEmit` exit 0（改错路径当场报，这一刀没有运行期新接缝，故不做变异核验）、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 101 文件 / 1,400 通过（用例数不变）、`npm run build` exit 0（49.13s）、`cargo test` 343 通过 / 0 失败 / 1 忽略。
- 落差：① 搬动后 `stores/ai` 里出现了「纯计算」文件，与「store 只放状态与动作」的直觉不完全一致——同目录的 `limits.ts` / `prompts.ts` / `session-codec.ts` 已经是这个形状，本次按既有先例走。② `estimateTokens` 的宽字符区间表仍是硬编码的五段码点，遇到新增的全角区段要手改；本批不改行为。③ 本轮没跑真机。

### 工程：公式类名收口成常量 + AI 设置父级连接区补用例（M 批，机械路线之外的收口）

- 这一批不做拆分，只清 P5 结束时留下的两条「补断言级别」的落差：一处渲染层写死了字面量、一处父级连接区没有直接用例。产品代码总共动了一行，且改的是耦合而不是行为。
- 改动一：`src/features/ai/Markdown.tsx:155` 的 `display ? "ai-math-block" : undefined` 换成 `display ? MATH_CLASS_BLOCK : undefined`。常量的值就是那串，所以界面一个字都没变；变的是「谁跟着改名走」——`ai-math.ts:32` 造占位节点用常量，`Markdown.tsx:250` 认占位节点也用常量，唯独 KaTeX 出图前那个兜底 span 写死字面量：真把类名换掉，就会变成「认得出是公式、渲染出来却没类名」，配色与按类名取节点的选择器同时落空。
- 新建 `src/features/ai/Markdown.test.tsx`（5 条，jsdom）。KaTeX 的替身给两种状态——一条永不 settle 的 Promise（停在 TeX 原文兜底）与立即出图，断言：块级兜底 span 的类名取自 `MATH_CLASS_BLOCK`、行内故意不带类名、块级与行内分别按 `displayMode` 的 true / false 调 KaTeX（即「认类」与「回写类名」是同一条链而不是两处各判）、出图后类名仍在且正文换成渲染结果、代码块里的 `$` 一次 KaTeX 都不调。用例按 `.${MATH_CLASS_BLOCK}` 查节点，所以「类名与常量脱钩」是看得见的。
- 五条变异核验（每次改坏一处 → 跑用例 → 逐字节还原并断言与变异前一致）：MathSpan 退回字面量**同时**把常量改名（真脱钩）→ 2 红；兜底 span 丢掉类名 → 2 红；块级错用行内常量 → 2 红；认类判定把块级当行内（`displayMode` 接反）→ 4 红；出图后丢类名 → 1 红。
- 改动二：`src/features/settings/SettingsAi.test.tsx` 16 → 30 条，补 P5-5 明写过的落差——父级留下的连接区（服务商/协议/全局 Key/`maxChars`/三个开关/两个按钮 + 首帧 effect）在拆分前后都没有直接用例。新钉住的：首帧拉到配置既回填界面、又把同一份原样 `setConfig` 交给 AI store；选带原生协议的服务商时地址/模型/协议三项一起带过去；选 OpenAI 兼容的服务商时协议收回自动识别而不是留着上一家的；服务商下拉里没有的历史值收回 `custom` 再落库；协议族单独可改且只动 `protocol`；全局 Key 填了才覆盖、落库成功后输入框清空、未存过时给「未设置」占位且不出掩码行、凭据库不可用时明文警告出现；`maxChars` 离开输入框即落库；启用/改前确认/工具调用三个开关各只翻自己那一项；测试连接与拉取模型都是**先落库再打**（按 `invocationCallOrder` 断先后），成功后给提示、失败后报错进 toast 且按钮回到可点、拉回来的模型把手填输入框换成下拉并保住当前值。
- 夹具两处必要改动（都在测试侧）：`AI_PROVIDER_PRESETS` 的替身从 1 条扩到 3 条，才有「带原生协议」与「OpenAI 兼容」两种形态可分；`sonner` 的 `toast` 从匿名 `vi.fn()` 换成 hoisted 的两个 spy，成功/失败提示本身成了被测对象。三个开关那条用例给本文件装了一台最小假服务端（`aiSaveConfig` 写进 `state`、`aiGetConfig` 读回 `state`）：`ai_save_config` 是覆盖式的，无状态的桩根本断不出「下一次保存有没有把上一次的改动带走」。
- 十五条变异核验（改坏 `SettingsAi.tsx` 一处 → 跑该文件 → 逐字节还原）：预设切换漏带协议 → 1 红；漏带模型 → 1 红；provider 回填不认的兜底删掉 → 1 红；兜底改成写死 `custom` 但洗掉地址 → 1 红；`maxChars` 不回填 → 1 红；首帧不交给 AI store → 1 红；留空 Key 也当覆盖 → 1 红；保存后不清空 Key 输入框 → 1 红；测试连接不先落库 → 1 红；拉取结果没进下拉 → 1 红；拉取失败不提示 → 1 红；测试失败后按钮不复位 → 1 红；落库不带当前表单 → 23 红；`useTools` 硬编码 → 1 红；协议下拉不即时落库 → 1 红。
- 有一条断言是假的，改对了才留下：最初写的是「服务商下拉里回填成 custom」，把兜底整条删掉它仍然绿——jsdom 里 `<select value="…">` 指向不存在的选项会退回首个选项，「显示成自定义」根本断不出差异。改成走落库那一步断（野值 `ollama` 会被原样写回服务端），才真打死那次删除。教训与 H 批那条同源：**新用例配一条变异，别只看它绿不绿。**
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 102 文件 / 1,419 通过（+19：Markdown 5 条 + SettingsAi 14 条）、`npm run build` exit 0（51.47s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。
- 落差：① 手改 Base URL 后离开输入框落库这条仍没单独钉，只在「收回 custom 再落库」那条里断过它被原样带回。② `ai-math.ts` 里关于 `(?!\d)` 的旧注释说法仍不准，本批不碰（改注释属另一类批次）。③ `get_page_content` 复杂块的 Markdown 形态还是没断言。④ 新增用例只到 jsdom 的 DOM 层，档位/预设下拉的真机选项文案与配色没在 `npm run tauri dev` 的原生窗口复验。⑤ Markdown 的用例文件只覆盖了公式那一族组件（表格、代码高亮、mermaid、引用链接仍无渲染用例），本批不为凑数往外扩。

### 工程：mermaid 围栏的「等笔停再画」有用例盯着，公式那行旧注释改写实（N 批）

- 接着 M 批落差⑤与②各清一条：给 `MermaidBlock` 补渲染用例，把 `ai-math.ts` 里说法不准的旧注释改写实。**产品代码零改动**（`Markdown.tsx`、`ai-math.ts` 的代码体一个字没动，只有注释换了措辞）。
- 注释那条先取证再改写：拿三种正则（原样、去掉 `(?<!\s)`、去掉 `(?!\d)`）跑七组输入，实测「要 $100 和 $200」是**两条一起挡**（留了空格，`(?<!\s)` 就够；单去任一条它都不漏）；`(?!\d)` 真正独力挡的是分隔符不留空格的「价 $100，$200 元」「价 $100。$200 元」和紧跟数字的「共 $x$2 个」；`(?<!\s)` 独力挡的是「$b $」这种闭合前留空的。旧注释把第一条的功劳记在 `(?!\d)` 名下，`ai-math.ts:12-15` 按这个口径改写了四行。
- 新注释的说法要有用例钉着才不算又是一句散文：`ai-math.test.ts` 补 1 条（两个断言）——「价 $100，$200 元」「价 $100。$200 元」不当公式。去掉 `(?!\d)` 时它与既有的 `$x$2` 那条一起红，去掉 `(?<!\s)` 时它**不红**（正是注释里「`(?<!\s)` 帮不上」的意思）。
- `Markdown.test.tsx` 新增一个 describe（6 条），钉住 mermaid 围栏的四条形变：① 350ms 防抖到点前一次 `renderMermaid` 都不调，界面只有源码且不报失败；② 流式增量连续改正文时只按**最后停下的那份**画一次（用 `rerender` 换正文 + 假计时器推进）；③ 画成后源码整块换成图、不出提示，画失败则退回源码并给提示；④ 正文还没写（空围栏）不去画；⑤ 换了正文之后，上一半截那次的迟到结果不落地（第一个 `renderMermaid` 的 Promise 手动 hold 住，等第二次画完再 resolve，断 DOM 里只有第二次那张图）——这条管的是 effect cleanup 里的 `cancelled`。
- 夹具三处必要改动（都在测试侧）：`renderMermaid` 从匿名 `vi.fn()` 换成 hoisted 的**带签名**替身（`vi.fn<(code: string) => Promise<string>>()`，否则 `mock.calls[0][0]` 是无类型 `any`，`no-unsafe-call` 直接警告）；`afterEach` 加 `vi.useRealTimers()` 防假计时器漏给后续用例；文件头补两行说明「另一条异步兜底是 mermaid，只有假计时器能看出半截语法那一帧根本没去画」。
- 有一条断言按实际形状改过写法：围栏正文取到手时带尾随换行（`"graph TD; A-->B\n"`），所以「按最后停下的那份文本画一次」断的是 trim 后相等，不是 `toHaveBeenCalledWith(原文)`——这是第一次跑就暴露的，不是事后凑绿。
- 八条变异核验（改坏一处 → 跑该文件 → 逐字节还原并断言与变异前一致）：`(?<!\s)` 去掉 → 既有金额那条红（新用例不红，与注释一致）；`(?!\d)` 去掉 → `$x$2` 与新补那条一起红；防抖 350 → 0 → 「半截不去画」「只画一次」两红；cleanup 里不置 `cancelled` → 迟到结果那条红；`failed` 不回退源码 → 画失败那条红；空正文也去画 → 空围栏那条红；未出图也常显失败提示 → 「半截不去画」「空围栏」两红；不清旧计时器 → 「只画一次」红。八条全点到预期用例，无一条假绿。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 102 文件 / 1,426 通过（+7：mermaid 6 条 + ai-math 1 条）、`npm run build` exit 0（52.20s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。
- 落差：① 「先画成功、随后改正文画失败」这个 `svg → 提示` 的过渡没单独钉，变异打死的是终态而不是那次翻转。② 用例只到 jsdom；真机里 mermaid 的脚本是按需加载，首次出图要拉包，350ms 防抖盖不住那段耗时，本批没在 `npm run tauri dev` 的原生窗口复验。③ 编辑器里的 `features/editor/extensions/mermaid/component.tsx` 是第二份相近的 mermaid 渲染实现（同样用 `renderMermaid`），本批只钉 AI 面板这一份；把两处的防抖与兜底口径收成一个属形状变更，需拍板。④ `(?<!\s)` 的独力挡位（`$b $`）落在既有用例里，没为注释另补新条。

### 工程：mermaid 出图的状态机补上两条过渡用例，公式挡位补成一对一（O 批）

- 目标是把 N 批留下的四条落差清掉：①④是能补的用例，本批补完；②③取证后判定**不属机械路线**，只给证据与选项，不动工。**产品代码一字未改**（`Markdown.tsx` / `ai-math.ts` 都不在改动清单里）。
- 补 ④：`ai-math.test.ts` +1 条「值 `$b $` 与 `$c$`」——断言 `$b $` 不算公式、同段的 `$c$` 照常命中。这类「独力挡位」的断言得两头都验才算数：去掉 `(?<!\s)` 这条**红**（挡位没了），去掉 `(?!\d)` 这条**不红**（说明 `(?<!\s)` 确实在独力干活、且没顺带把一个真公式也挡掉）。
- 补 ①：`Markdown.test.tsx` +2 条过渡用例。「先画成功、再改正文改失败」——旧图在屏上时正文改坏，界面要撤掉图、退回**新**源码并给提示；「改坏了再改回来」——失败过一次之后重新画成功，提示要撤掉、源码让位给新图。
- 落差①最初的描述本身被实测纠正了：原话是「catch 里的 `setSvg("")` 没人钉」。把那行删掉跑全量 13 条**全绿**——失败态早就被 `if (failed)` 挡在 `if (!svg)` 前面返回源码了，那行只是防御性清理，没有任何可观察行为。于是用例改成钉两处真接缝：`if (failed)` 的优先级（删掉判定 → 4 红，含这两条新用例）与画成功时的 `setFailed(false)` 复位（不清 → 恰好 1 红，就是「改坏了再改回来」）。**教训：补用例前先问「这行删掉界面会不会不一样」，别照着代码行的位置许诺断言**——与 M 批那条 jsdom `<select>` 假绿是同一类事。
- 落差②（真机里 mermaid 首帧的观感）取证到能取证的地步：`npm run build` 产物里 `dist/assets/mermaid.core-*.js` 是 **654KB 的独立懒加载块**（`src/lib/mermaid-render.ts:6` 的 `mermaidPromise ??= import("mermaid")`），所以「首次出图要先多取一个包」是真的。但要在真机窗口里看那一帧只有两条路：在编辑器插一个 mermaid 块（会写真实开发库 `appflowy.db`，那是本人数据，属禁区），或在 AI 面板问出一张图（要真供应商、真花费、还会落会话）。本批不冒这个险，列为待拍板。
- 落差③（两份 mermaid 实现要不要合一）取证后判定是**行为变更**：AI 侧 `MermaidBlock` 防抖 350ms（`Markdown.tsx:127`，为了流式增量不闪半截图）、失败退回**源码**；编辑器侧 `MermaidNodeView` 防抖 0ms（`extensions/mermaid/component.tsx:47`）、失败显示**错误文案 + 可滚动的错误正文**（`:89-95`），还带 draft / editing / commit 与双击进编辑整套 NodeView 语义。真正该共用的一层——`securityLevel: "strict"`、离屏渲染宿主、临时元素兜底清理——本来就已经收在 `lib/mermaid-render.ts` 里；再往上合，就得先回答「退出编辑后晚 350ms 出图能不能接受」「AI 面板要不要也显示错误正文」，这是产品口径而不是搬代码。
- 变异核验 5 条（改坏一处 → 跑该文件 → 逐字节还原并断言与变异前一致）：去掉 `(?<!\s)` → 2 红（新用例 + 既有金额那条）；去掉 `(?!\d)` → 2 红但**不含**新用例（正是「独力」的意思）；catch 里不清 svg → **全绿**（据此判定该行不可观察，改钉别处）；去掉 `if (failed)` 判定 → 4 红；画成功不清 `failed` → 1 红。
- 静态验证：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 102 文件 / 1,429 通过（+3：mermaid 2 条 + ai-math 1 条）、`npm run build` exit 0（1m，mermaid 独立块的产物大小即出自这次构建）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰）。
- 落差：① mermaid 真机首帧仍未复验，需要「允许在真机窗口里做一次带写入的冒烟」或「接一个真供应商」二者之一的授权。② 两份 mermaid 实现的合一口径等拍板（本批只交证据）。③ 组件被卸载重挂时（同一轮里 `code` 没变）会不会重复出图没钉住——jsdom 里造不出那条 React key 变化路径。④ `Markdown.tsx` 里 `CodeBody` 的高亮失败与 `MermaidSource` 之外的组件族（表格、引用链接）仍无渲染用例。

### 工程：`get_page_content` 喂回模型的正文第一次按 Markdown 形状钉住（P 批）

- 清 M 批留下的落差③（「`get_page_content` 复杂块的 Markdown 形态还是没断言」）。**产品代码零改动**：`git status` 从头到尾只有 `src/lib/ai-tools.test.ts` 一个文件。
- 为什么值得钉：只读取证工具返回的字符串是原样喂回模型的正文，模型靠 `##`、`- `、表格那行 `| --- | --- |`、代码围栏上的 `ts` 这些记号认出「这是一张表 / 一段代码」。`readPageMarkdown` 里那次序列化一旦退成把库里的 JSON 直接 trim 端出去，界面不报错、老用例也不报错（此前只喂过单个段落），模型于是开始把 `{"type":"doc"...}` 抄进它写的正文里。
- 三条新用例（`src/lib/ai-tools.test.ts` 的 `describe("检索工具喂回模型的正文")`）：① 二级标题 + 带加粗的段落 + 无序列表 + 表格 + 带语言的代码块 + 引用，逐字断言喂回去的**整串** Markdown，含块与块之间那个空行（少一个换行，列表和表格就粘成一行）；② 正文还有另一种真实存法——顶层直接是块数组、没有 `{ type: "doc" }` 包着，少掉那次归一化同样不报错，只会让模型拿到一整串 `<!-- unsupported block -->`；③ 截断口径按喂回去的**正文**算，不按库里的 JSON 长度算——三个字的内容包在列表结构里 JSON 有 336 字，按 JSON 判会把这篇误报成超长，`…（已截断 N 字）` 里那个 N 也说错数（模型正是拿它判断要不要再来一轮片段检索）。既有的兜底那条补 2 行：结构齐全、一个字的正文都没写，同样算「还没有正文」。
- 六条变异核验（改坏 `retrieval.ts` 一处 → 跑该文件 → 逐字节还原并断言与变异前一致）：`jsonToMarkdown(doc).trim()` 换成 `raw.trim()` → 4 红；丢掉块数组归一化 → **恰好 1 红**且只红新那条（证明它在独力干活，此前没人钉）；`md.length <= limit` 换成按 JSON 长度判 → 1 红；「已截断 N 字」按 JSON 算 → 2 红；片段之间的 `\n…\n` 换成 `\n` → 1 红（早被既有那条钉着，本次复验）；空正文改成返回裸换行 → 1 红。六条全点到预期用例，无一条假绿。
- 一处工具事故（不影响产物，记下来防再犯）：变异脚本第一版用 Python 文本模式读写 `retrieval.ts`，Windows 下 `\n` 被写成 `\r\n`，还原时留下整文件的行尾差异、脚本自己的逐字节断言当场报错。立刻按备份复制还原，`git status` 复验只剩用例文件；之后脚本一律改 `read_bytes` / `write_bytes`。
- 静态验证：`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 102 文件 / 1,432 通过（+3）、`npm run build` exit 0（56.08s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。那串预期 Markdown 是**第一次跑就命中的**，不是照实际输出回填——`## 周报` / `- 写测试` / `> 下周继续` 这些形状本就该由 `lib/markdown/render.ts` 保证，这次是确认取证这条路真的用了它。
- 落差：① 只钉了 `get_page_content` 这一条取证路径，另三条（`search_workspace` 的 snippet、`list_database_fields` 的选项名、`query_database` 的行 id 表头）各有早于本批的形状断言。② 块类型只测到六种：toggle / columns / databaseView / attachment / math / outline 在 `markdown/render.test.ts` 有导出用例、但没走过取证工具这条路。~~callout 与 mermaid 连导出侧用例都没有~~ **此说写错了，下一批按实测更正：callout 的导出形状有逐字断言（`roundtrip.test.ts:135` 的「> 💡 **Callout**\n> 提示正文」与 `:151` 的非默认色标记），mermaid 围栏的形状断言在 `parse.test.ts:137`，两处都不用另补。**③ `docSearchSnippets` 召回的片段本身是 Markdown 还是纯文本没查（本批只钉了「片段之间用 `\n…\n` 连」）。④ 本轮没跑真机。

### 工程：AI 面板的代码高亮与链接分岔补用例，并更正上一批写错的落差（Q 批）

- 三件事：① 清 O 批落差④（`Markdown.tsx` 的 `CodeBody` 与表格 / 引用链接那族组件没有渲染用例）；② 取证 P 批落差③（片段到底是什么形状）；③ **更正 P 批落差②里一句写错的话**。**产品代码零改动**：`git status` 只有 `src/features/ai/Markdown.test.tsx` 与 `CHANGELOG.md`。
- 更正那条先说清楚：P 批写过「callout 与 mermaid 连导出侧用例都没有」，实测不成立——`markdown/roundtrip.test.ts:135` 对 callout 是**逐字**断言 `> 💡 **Callout**\n> 提示正文`，`:151` 钉住非默认色的 `<!-- color:green -->` 标记，`markdown/parse.test.ts:137` 断言 mermaid 围栏导出的原样形状。当时只 grep 了 `render.test.ts` 一个文件就下了结论，而那两个块的用例分别住在 roundtrip 与 parse 里。**教训与 M / N 批同一条**：说「没人钉」之前要把整个测试目录查完，不是查一个文件。
- 落差③（片段形状）取证到 Rust 侧：`doc_search_snippets`（`src-tauri/src/commands/db/ai_sessions.rs:122`）走 `db::search::search_in_view`（`src-tauri/src/db/search/query.rs:277`），SQL 是 `snippet(documents_fts, 2, '', '', '…', 48)`——第 2 列是 `document_text` 视图（`migrations/010_documents_plain_text_fts.sql`）用 `json_tree` 抽出的**纯文本**（text 叶子 + mention 的 `label`，空格拼接），起止标记传空串所以不带 `<mark>`，窗口 ±48 个 token。结论：走片段这条路喂给模型的是纯文本窗口，标题 / 表格 / 代码围栏的形状在索引时就不存在了；这是 010 迁移刻意的口径（不把 JSON 结构噪声喂进检索与 bm25 排序），不是缺陷。前端能钉的只有连接符（`\n…\n`，早已钉住），片段内容形状归 Rust（`db/docs.rs` 的索引用例盯着）。
- 新用例（`Markdown.test.tsx` 13 → 22 条）。代码高亮 3 条：注册过的语言出 `span.hljs-*`、且外层 `<code>` 读出来仍是原正文；模型臆造的别名（`typescriptx`）退回纯文本且一次 `highlight` 都不调——注释里写明「不做自动嗅探，嗅探会把 ts 认成别的语言」，这条把它落成断言；流式里正文接着写要按**新**正文再高亮一次，界面上留的不是旧文本。链接与 GFM 6 条：`[id=v1]` 变成站内引用链接、点击只打 `openRowInView("v1")` 不碰 `openUrl` 且 `preventDefault` 真生效；树里查无此页时留原样文本、不造一个点不动的假链接；代码块里的 `[id=v1]` 是源码不是正文，不成链接；普通外链交 `openUrl` 并带着 `target="_blank"` 与 `rel="noopener noreferrer"`；外链打开失败时错误文案进 toast；GFM 生效——模型给的表格成 `<th>` + `<tbody>`、任务列表成勾选框且两种 checked 状态各归各。
- 夹具四处（都在测试侧）：`openUrl` / `openRowInView` / `toast` 从匿名 `vi.fn()` 换成 hoisted 的具名替身——本文件早就 mock 了它们，但一条都没断过，等于分岔没人看；新增 `@/lib/code-highlight` 的 lowlight 替身（只认 `ts`，`highlight` 产出真实 lowlight 会产出的 element + text 两类 hast）；文件顶层 `bindFakeApp` 绑一棵带 `v1=周报` 的页面树，因为引用标题要在树里解析（不绑就撞 `app-context` 那条「树没绑直接抛」的口径）。
- 十条变异核验（改坏一处 → 跑该文件 → 逐字节还原并断言与变异前一致），每条**恰好红一条**且红的正是预期用例：`remarkGfm` 从插件表里掉出去 / `citationViewId` 判定不生效 / 引用点击不拦默认动作 / 外链点击不拦默认动作 / 外链失败不再提示 / 不管注册没注册都高亮 / 丢掉 `noreferrer` / 高亮的 effect 依赖漏掉 `code` / 解析不到页面也造链接 / **引用前缀换成 `tsflowy:` 自定义协议**。最后一条顺手把 `ai-citation.ts:10-13` 那句注释验实了：自定义协议会被 react-markdown 的默认清洗剥掉 href、链接当场点不动，所以相对形态 `tsflowy-citation/<id>` 不是随手起的名。
- 有一条**没**写成用例，理由是没有可观察行为：`CodeBody` 里 `.catch(() => setNodes(null))`——`nodes` 初值本来就是 `null`（纯文本），把整行 catch 删掉跑全量 22 条照样全绿，与 N 批那条 `setSvg("")` 同类。所以「出错退回纯文本」这半句真正钉住的是「高亮这一步抛异常时界面仍是纯文本」，而那条路走的就是 `nodes === null`，不是那个 catch。
- 静态验证：`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 102 文件 / 1,441 通过（+9）、`npm run build` exit 0（58.43s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。
- 落差：① 「整包 lowlight 加载失败」这条真路径没测到——`lowlightPromise` 是模块级缓存，要打开得 `vi.resetModules()` 再动态重导 `Markdown`，本批没做（见上一条：那个 catch 本身也不可观察）。② 点击引用后的真实跳转被 mock 在 `openRowInView` 处，站内深链自身的行为不在本文件（`lib/deep-link` 有自己的用例）。③ GFM 只钉了表格与任务列表两种形态，删除线 / 自动链接同属一条插件、已被这两条打死。④ `features/ai` 里 `EditDiffDialog.tsx`（66 行，「改前确认」那道闸门）、`MessageBubble.tsx`（295 行）、`AiParts.tsx`（104 行）三个组件仍零用例；本批按 O 批落差④收的只有 `Markdown.tsx` 一族。⑤ 本轮没跑真机；O 批留下的两条需拍板（mermaid 真机首帧、两份 mermaid 实现是否合一）仍在等点头。

### 工程：AI 动作卡片与 diff 闸门的判定补用例，并更正上一批那句「没有可观察行为」（R 批）

- 四件事：① 收 Q 批落差①（lowlight 按需加载这条真路径没测到）；② 收 Q 批落差④里剩下的两个组件 `MessageBubble.tsx` / `EditDiffDialog.tsx`；③ 取证 Q 批落差②③（站内深链与 GFM 其余形状）；④ **更正 Q 批写下的「`.catch` 没有可观察行为」**。**产品代码零改动**：`git diff --exit-code src/features/ai/Markdown.tsx src/features/ai/MessageBubble.tsx src/features/ai/EditDiffDialog.tsx` 干净，`git status` 只有 `Markdown.test.tsx`（改）+ 两份新用例 + 本文件。
- 先说更正那条，因为它推翻的是上一批的判断口径。Q 批按「首挂载时 `nodes` 初值本就是 `null`」判定那个 catch 纯防御、删掉没有可观察差别；漏的是这组件真实的工作序列是**流式**——正文从第一版 rerender 到第二版时，`nodes` 里存的是**上一版**的 hast，`.catch(() => setNodes(null))`（`Markdown.tsx:79-81`）清掉的正是那一份。变异「删掉整行 catch」当场红一条新用例（「高亮这一步抛异常：退回当前正文的纯文本，不残留上一版的着色」，断的是 DOM 里一个 `<span>` 都没有、读出来是**新版**正文）。与 N 批那条 `setSvg("")` 的判定形同、结论相反，差别就在「只看了第一次渲染」：**判「有没有可观察行为」要把组件放到它被使用的序列里，不是只看初值**。
- 落差①怎么打开的：`lowlightPromise` 是模块级缓存，`vi.resetModules()` 不重放 `vi.mock` 的工厂，所以计数器不能写在工厂里——改成挂在被 mock 的那个导出的 **getter** 上（`get lowlight() { hl.imports += 1; return hl; }`），源码每次 `import("@/lib/code-highlight").then((m) => m.lowlight)` 都真实读一次绑定，计数就落在「取了几次包」上。新用例 `resetModules()` 后动态重导 `Markdown`：没有围栏的答案取 0 次、两个代码围栏只取 1 次（顺带断出 `span.hljs-ts` 两个）。另两条钉「渲染不挂在加载上」：包还没到位那一帧就是纯文本、`highlight` 这一步抛异常退回纯文本。`Markdown.test.tsx` 22 → 27 条。
- 落差④的两个组件各自是新文件。`MessageBubble.test.tsx`（16 条）钉的是「点错一下就动到文档」那套判定：卡片文案按「改文档」与「其它写动作」分岔（`MessageBubble.tsx:41-57`，已应用 / 已忽略 / 没写成三档六格一张表）、`undone` 压过 `applied`（`:54`）、`malformed` 不带 summary 后缀（`:152-157`）、旧版本存进 `detail` 的裸 key 要翻成人话而翻不到的原样显示（`:60-70`）；按钮闸门是「只有待确认给应用/忽略、且点击带上是第几张」（`:160-168`，两张卡片里第一张已应用时索引必须是 1）、「撤销」要看 `revert ?? undo` 两套逆操作（建页重启后不可一键回滚那条就落在这里）、`canShowDiff` 七档表（`:72-77`，`set_page_title` 与 `rejected` 不给弹 diff）；气泡侧钉去重（`:109` 正文与首张卡片说明同句时气泡与回写那一排一起让位）、空气泡的「…」占位、流式进行中整排消息级操作消失但待确认的「应用」还在、提问与回答的操作集分岔、评分的 `aria-pressed`。这文件**刻意不 mock `@/lib/i18n`**——「裸 key 翻没翻」只有真字典看得出差别，house style 的恒等替身会让两条分支返回同一个字符串。
- `EditDiffDialog.test.tsx`（8 条）是 AI 动到文档前的最后一道肉眼闸门：只有 `state === "pending"` 给「应用」（`:22`、`:52`），已应用 / 已忽略 / 没写成 / 格式有误四档都不给（点了就是重复落地），父层没传 `onApply` 时不出现一个点了没反应的按钮；点的顺序也是行为——**先落地再关窗**（`:54-60`，反过来的话落地失败时提示已经没地方放了），用 `mock.invocationCallOrder` 断。插入类动作没有原文，左栏要说「无原文」而不是给个空框（`:38` 用 `record?.before.trim()` 判，不是判有没有）；跨页动作要说清落点是哪一页（`:30-31`，没页面名就不印这一行）；`record` 还是 `null`（关闭动画期间父层已清空）时不崩。这类弹窗的内容走 radix 的 portal 落在 `document.body`，`render()` 返回的 `container` 是空的——查询得用 `screen` / `document`，不然「没渲染出来」会伪装成一条绿。
- 落差②③靠取证收，不写代码：②「点击引用后的真实跳转」在 `src/lib/deep-link.ts` 一侧本就有 `deep-link.test.ts:72-149` 六条钉着，含「不传 `rowId` 就不碰行聚焦」（`:93`）与「没绑定运行态时直接抛」（`:145`），`Markdown.test.tsx` 只 mock 到 `openRowInView` 这道接缝是对的分工，不是缺口；③ GFM 补上删除线（`~~作废了~~` 出 `<del>` 且界面上不留裸 `~~`）与自动链接（裸 URL 成链接、带着 `rel="noopener noreferrer"`、点击只交 `openUrl`）两条形状。
- 二十三次运行、二十二处不同改坏（改坏一处 → 跑该文件 → 逐字节还原并断言与变异前一致；`Markdown.tsx` 三条、`MessageBubble.tsx` 十五条、`EditDiffDialog.tsx` 四条，其中「待确认不再分岔」这一处换三个方向各验一次，另有一次与前一遍同题故去重）：**二十一条红**，红的都是预期用例（`ED4` 红两条，页面名那行与 `record=null` 那条共用这一判定）。唯一一条绿的是「待确认一律走『其它动作』那套文案」——中文里 `ai.editPending`（「AI 建议修改文档」）与 `ai.actionPending` 插 `{name}`="修改文档" 拼出**同一句话**，英文也只差一个冠词（"the document" vs "a document"），这一档的分岔在当前字典下**没有可观察行为**，所以它记成诚实的未覆盖，不为其造断言；反向那条（一律走「改文档」那套）是红的，同一条文案表在已应用 / 已忽略 / 没写成三档也全都红。
- 本轮踩到的 lint 红线（`--max-warnings=0` 下一条警告就阻断）：`it("…", async () => …)` 里没有 `await` 触 `require-await`；`btn() as HTMLElement` 触 `non-nullable-type-assertion-style`，改用 `!`；`NodeList.item(i)` 之后判空触 `no-unnecessary-condition`（`noUncheckedIndexedAccess` 关着，类型上永不为 `undefined`），改成 `if (list.length <= index) throw …` 再取下标。另一条工具坑：验证链脚本里 `{ npm run lint 2>&1 | tail -5; echo "lint exit=$?"; }` 报的是 `tail` 的状态，lint 挂了照样打印 exit=0——本轮第一遍就是这么把红报成绿的，改成直接 `echo $?`、管道段用 `${PIPESTATUS[0]}`。
- 静态验证：`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 104 文件 / 1,470 通过（+29）、`npm run build` exit 0（57.53s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。
- 落差：① 中文文案同义导致「待确认」那一档的分岔断不出来——要钉它得改字典措辞或改用英文资源，两者都是行为/文案变更，不属本批。② `features/ai` 里仍零用例的是 `AiParts.tsx`（104 行，`ImageThumb` 的异步取字节 + 迟到结果丢弃）与 `AiPanel.tsx`（548 行，再往下切要先定组件边界，属需拍板）。③ `MessageBubble.test.tsx` 把 `./Markdown` 与 `./AiParts` 换成了替身，气泡里的 Markdown 形状只在 `Markdown.test.tsx` 那侧断，两文件之间没有交叉证据。④ 本轮没跑真机；O 批留下的两条需拍板（mermaid 真机首帧、两份 mermaid 实现是否合一）仍在等点头。

### 工程：缩略图的异步解析、气泡到 Markdown 的接缝补用例，并把上一批那句「断不出来」改口（S 批）

- 三件事对着 R 批留下的三条落差：① 收落差①——「待确认」那一档的分岔改用**英文字典**钉住（不改字典措辞、不改产品代码）；② 收落差②的前半——`AiParts.tsx`（104 行，`ImageThumb` 的异步解析 + 迟到结果丢弃）从零用例到 9 条；③ 收落差③——`MessageBubble.test.tsx` 与 `Markdown.test.tsx` 之间补上交叉证据。**产品代码零改动**：`git diff --exit-code src/features/ai/AiParts.tsx src/features/ai/MessageBubble.tsx src/features/ai/Markdown.tsx` 干净，`git status` 只有 `MessageBubble.test.tsx`（改，16 → 18 条）+ 两份新用例 + 本文件。
- 落差①先更正上一批的判断。R 批写「这一档的分岔在当前字典下没有可观察行为」，**只对了一半**：分岔在 `MessageBubble.tsx:48`，中文里 `ai.editPending`（`zh.ts:1077`「待确认：AI 建议修改文档」）与 `ai.actionPending`（`:1173`「待确认：AI 建议{name}」）插 `toolNameApplyEdit`（`:1166`"修改文档"）拼出同一句话；但 `t()`（`src/lib/i18n.ts:12-21`）读的是**运行态里的语言**，英文字典里两条分支差一个冠词（`en.ts:1119` "Pending: the AI suggests a document change" vs `:1220` "…suggests {name}"，`:1213` `ai.toolNameApplyEdit`="document change"）。语言是读出来的值、不是要改的东西，所以用例里 `bindFakeApp({ lang: "en-US" })`（`src/test/app-fakes.ts`，`afterEach` 统一 `dispose()`，免得脏语言留给后面的用例）就能把这档分岔变成可断的：新用例（`MessageBubble.test.tsx:123`）先按默认的改文档动作断出带 `a document` 那句，再 rerender 成 `create_page` 断出 "page creation"。变异「待确认不再分岔」因此从绿转红，红的正是这条。**口径记下来**：判「换文案才断得出」之前，先看有没有另一份字典能断——分岔本身是可观察的，不可观察的只是中文这一份巧合。
- 落差②前半是 `AiParts.test.tsx`（9 条）。`ImageThumb` 的地址异步解析（`assets/xxx.png` → asset 协议 URL，`src/lib/assets.ts:23-26`），三条分支各一条钉：URL 没回来时是占位灰底而不是 `src` 空着的破图（`:49`）、解析出来才换 `img` 且 `alt`/`title` 都是附件名（`:57`，读屏和加载失败时该看见名字不是路径）、解析失败继续留占位（`:67`）。最值钱的是 `alive` 那两条：把 `resolveAssetUrl` 换成**手动门**的 Promise（hoisted 替身里 `gates.push({ resolve, reject })`，每条用例自己决定谁先落地、落成什么），成功分支（`:75`「上一张迟到的解析结果不许盖掉这一张」，`AiParts.tsx:18`）与失败分支（`:89`「上一张迟到的解析失败也不许把这一张抹回占位」，`:21`）才能各自单独被验；用自动 flush 的夹具时两者同时落地，`alive` 删掉照样全绿。剩下的是闸门：删除按钮只在该给删除入口的地方出现（`:102`；`AiParts.tsx:41` 判的是 `onRemove` 传没传，会话里已发出的图不许从气泡上删）、`QuickButton` 的 `disabled` 得真的点不动而不是只淡一点（`:118`，rerender 放开后同颗按钮要能点）。
- 两条**没**写用例，理由还是没有可观察差别：`RowAction` 的 `danger`（`AiParts.tsx:74`）只多一个 hover class，整行删掉跑全量全绿（变异 AP7 就按「预期全绿」登记）；`ImageThumb` 卸载后那个 `alive` 挡住的是「对已卸载组件 setState」，React 19 既不报警也不留 DOM 痕迹。
- 落差③是 `MessageBubble.markdown.test.tsx`（3 条）。原文件把 `./Markdown` 换成了替身（只记交出去的文本），「交出去的东西真被解析」在两个文件里都没有证据；新文件反过来——用**真的** `./Markdown`，只 mock 它的异步与外部出口（`sonner`、`katex-render`、`mermaid-render`、`ipc-shell`、`deep-link`、`@/lib/ai`，`./AiParts` 换成一颗纯 `img`），断助手正文里的记号在界面上成 `<strong>` + `<th>` + `<tbody>` 且星号竖线不留着（`:76`）、同一条正文是提问时走纯文本分支原样留着（`:87`）、卡片与气泡并存时被解析的只有正文那一段（`:95`）。配合原文件新加的那条（`:257`，交出去的就是 `bubbleText`、不拼卡片说明、也只交一次）和去重那条补上的 `expect(mdSpy.texts).toEqual([])`，两文件之间第一次形成双向证据：替身侧钉「交出去的是什么」，真组件侧钉「交出去的确实被解析」。`vi.mock` 的作用域是每个测试文件、工厂不能共享，所以这第三条只能开新文件，往原文件加 case 是拿不到的。
- 十三次运行、十二处不同改坏（`AiParts.tsx` 七处、`MessageBubble.tsx` 五处；改坏一处 → 跑整个 `src/features/ai` → 逐字节还原并断言与变异前一致）：**十二条红**，红的都是预期用例（AP4 与 AP6 各红两条；MB4 红四条、MB5 红五条——气泡退成纯文本 / 提问回答分支反了会同时打掉多处断言）。唯一一条绿的是 AP7（`danger` 只改 class，见上）。**这一批改掉的却是变异工具自己**：AP3 第一版把 `{url ? (`（`:31`）换成 `{url !== null || (`，括号没配平，esbuild 直接 "Transform failed"、套件一条用例都没跑——退出码非零但**一条断言都没红**，脚本按「非零即红」把它记成了一条真红。修法是把判红收紧成「必须有 vitest 输出里那种以 `×` 开头的断言行」，另把 "Failed Suites" / "Transform failed" 单列成工具故障；然后把 AP3 换成两条能编译的改法重跑（两态反了 → 红 5 条；img 条件退成恒真 → 红 2 条）。与 R 批那条「管道后的 `$?` 是 `tail` 的状态」同类：**核验工具的退出码不等于结论，得读它到底输出了什么**。
- 静态验证：`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 106 文件 / 1,484 通过（+14）、`npm run build` exit 0（1m 14s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。
- 落差：① R 批落差②的后半还在——`AiPanel.tsx`（548 行）零用例，它是编排层（三十九条 `useAiStore` 选择器 `:32-70` 加六个本地状态 `:73-81`）；不动产品代码的路子是照 `SessionHistoryPopover.test.tsx` 那套在测试里造一个假 store 喂选择器，切组件才需要拍板。② 英文那条分岔钉的是当前两份字典的措辞：若以后把 `en.ts:1220` 也补上冠词，MB1 会当场变绿——那是文案变了、用例要跟着改，不是分岔消失了。③ 新文件把 KaTeX 与 mermaid 的异步渲染 mock 掉了（`renderTex` / `renderMermaid` 被替身接管），这两块的渲染只在 `Markdown.test.tsx` 那侧有证据；真机首帧那两条需拍板的（mermaid 首帧、两份 mermaid 实现是否合一）仍挂着。④ 本轮没跑真机。

### 工程：AI 面板那层编排判定有用例盯着了，公式与 mermaid 围栏也补上交接证据（T 批）

- 对着 S 批留下的两条落差：① 收落差①后半——`AiPanel.tsx`（548 行编排层）从零用例到 31 条（29 条随第一版提交，另两条是变异核验跑完后按证据补的，见下面两条），**不切组件、产品代码零改动**；② 收落差③——`MessageBubble.markdown.test.tsx` 3 → 5 条，把 KaTeX 与 mermaid 两块「只在 `Markdown.test.tsx` 那侧有证据」的渲染，接成从气泡出发的端到端证据。**产品代码零改动**：`git diff --exit-code src/features/ai/AiPanel.tsx src/features/ai/Markdown.tsx` 干净，`git status` 只有新建的 `AiPanel.test.tsx` + 改动的 `MessageBubble.markdown.test.tsx` + 本文件。
- `AiPanel.test.tsx` 的夹具照屋里已有的形制：`vi.mock("@/stores/ai")` 里用 `zustand` 的 `create` 现造一棵假 store（面板的三十九条选择器读的就是它），子件（`MessageBubble` / `AiParts` / `SessionHistoryPopover` / `EditDiffDialog` / `ConfirmDialog` / `AiComposer`）全换替身——各子件自己那层形状由各自的用例文件钉，这里只断「面板有没有把它们接对」；`@/lib/i18n` 用 key 恒等替身，断的是走了哪条分支而不是中文措辞。29 条覆盖的是编排层特有的那批闸门：三个空态各归各（未到配置只有加载中 / 开关·地址·模型缺一个都算未配置且连会话区都不出 / 配好了才谈消息）、头部四颗按钮各自的 disabled、流式期间「在忙什么」那一行（检索中 / 思考中 / 思考正文自己说话了就让位）、继续生成只认「最后一条是 AI 的半截回答」、错误按归类码给处理办法而认不出的码只说现象、停在底部才自动跟随（48px 容差要手钉几何）+ 上滑后给回到底部 + 换会话恢复跟随、拖宽松手后把 `window` 监听摘掉、递给气泡的 `api` 对象引用稳定（逐个内联箭头会击穿气泡的 memo）、回填两路与「编辑器不在一个字符都不写」、改提问的两步（标目标 + 回填并把光标放末尾）、用量行「算得出金额才显示」、档位选择器空名退回模型名、上下文范围下发选中的值、五条内置动作加自定义指令、两型确认框各打各的动作、看 diff 开的是那一张卡片而应用打的是新下标。
- 三条**踩过的坑**记在这里。其一：`@/test/ai-store-harness` 在**导入时**就注册了自己的模块级 `beforeEach`（要它内部绑定好的 mock 包），组件用例把它引进来会让该文件**每一条**用例都报 `workspaceState` 读不到——第一遍就是这么 29 条全红的；改成本文件里一个 `baseConfig()` 把 `AiConfig` 必填补齐。其二：真的 `@/lib/ai` 会顺着 `invoke` → `auto-sync` 拉到 Tauri 入口（那模块求值时就读一次配置），jsdom 里不需要那台机器，直接在用例里 mock 掉，金额与格式化只在 `lib/ai.test.ts` 钉形状。其三：`estimateAiCost(usageTotal, …)` 收的是**整个** `usageTotal` 对象（含 `total`），断言只写 `{ prompt, completion }` 会红——这一条是跑出来才知道的，不是想出来。
- `MessageBubble.markdown.test.tsx` 补的两条走的是「围栏原样交出去」：`$$E=mc^2$$` 经**真** Markdown 一路打到 `renderTex("E=mc^2", true)`（块级），出图后节点仍带 `MATH_CLASS_BLOCK`（`ai-math` 里那枚常量，M 批收口的）；mermaid 围栏笔停 350ms 后打给出图，且递出去的围栏正文 trim 后与原文一字不差（`vi.advanceTimersByTimeAsync(350)` 把防抖与 promise 链在同一次 tick 里落地）。夹具改了两处：`renderTex` / `renderMermaid` 两个替身原本是无签名的 `vi.fn()`，取实参 `mock.calls[0][0]` 在**类型上**不存在（`tsc` 报 "Tuple type '[]' … has no element at index '0'"），补成带前置参数的形制——这是 N 批那条「hoisted 替身要写签名」的复发，只不过这次红在类型而不是 lint。
- 变异核验**补跑完了**（上一批因关机只跑到第 6 条）：45 条（`AiPanel.tsx` 43 + `Markdown.tsx` 2，每条只改一处判定位 → 跑对应的用例文件 → 逐字节还原并断言与变异前一致），结果 **43 红 / 2 绿**。红的是按设计要红的：`api` 引用稳定那条确实是被「deps 里塞进每轮都变的 `streaming`」打死的（AP37），两型确认框互调打死两条（AP34），`busy` 恒传 `false` 打在引用稳定那条上（AP38），公式的 `display` 与 mermaid 的 350ms 各打一条（MD01/MD02）。脚本这轮加了两件上一批欠的东西：**journal 先落「路径 + 原文字节」再动刀**（被强杀后开机第一件事是重放还原，不再靠人肉 `git checkout`）与**按已完成清单续跑**。
- 两条绿各有各的说法，都不许糊过去。① **AP12 是等价变异**，不是覆盖缺口：把 `canContinue` 里的 `!streaming &&` 删掉界面毫无变化，因为外层 `:366` 那句 `{!streaming && canContinue && …}` 早就挡住了——同一道闸门写了两遍，删哪遍都不改行为（要清这层冗余属另一件事，本轮不动）。② **AP44 是 jsdom 断不出**：我为 `:453` 的野值兜底新加了一条「范围值是认不出的野值时不许塌成空白」，实测把整条兜底删掉后**用例照样绿**——`<select>` 找不到匹配选项时 jsdom 与 React 一起退回首个选项，显示仍是 `full`。用例注释已改成实话（它只钉「显示的是三个已知选项之一」，`AP29` 那种「显示成另一个已知值」还是打得死的），这条也算本仓在「select 显示层假绿」上栽的第三次。
- 绿的那条反而**逼出一个真缺口**：AP24（把用量行内层的 `usageTotal.total > 0` 删掉）第一版全绿，因为用例里「总量为 0」和「整行不渲染」是同一件事——总闸门 `showUsage` 先挡住了，内层那截闸门从没单独被验过。补了一条「只有跨会话累计、本会话一个 token 没跑」（`:413` 那截缺席、`:419` 那截在）之后 AP24 红。同理 AP20 第一版报的是「锚点不存在」（JSX 串我抄错一个括号），修正锚点后红。面板那组因此是 **31 条**（提交时 29 条 + 这两条）。
- jsdom 仍然断不出这些：① `:453` 那句「`ctx_scope` 不是 `page_only`/`off` 就退回 `full`」的**兜底本身**——AP44 实测：整条三元删掉，野值原样交给 `<select>`，jsdom 与 React 一起退回首个选项，界面与兜底后一模一样（已知值与「显示成另一个已知值」仍断得出，AP29 就红两条）；② 滚动几何全靠 `Object.defineProperty` 手钉 `scrollHeight`/`clientHeight`/`scrollTop`，48px 这个容差在真机上是否合适仍是经验值；③ `QuickButton` 的 disabled 真点不动由 `AiParts.test.tsx` 钉，这里只断面板传了什么。本轮没跑真机（按指示关机）。
- 顺带把长期挂着的四件「需拍板」问出了答复（此前只写在报告末尾，等于没问）：**两个巨型组件不再往下切**（`GridView.tsx` 933 / `EditorPage.tsx` 906，机械拆分路线到 K/L 批收尾，省下批次做补用例与功能缺口）；**mermaid 的两笔债维持现状**（真机首帧不验、面板 `MermaidBlock` 与编辑器 mermaid NodeView 两份实现不合一）；**三个禁区转另案排期**（`sync.rs` 整库 LWW 恒判本机胜、数据层零分页、恢复会话不还原 revert——都是行为变更，不再混进机械重构批）；**这一批的提交推送**（`7ae1280..8372753` 共 40 个提交进 `origin/main`，后续批次仍逐次询问）。
- 静态验证（本批收尾复跑）：`tsc --noEmit` exit 0、`eslint . --max-warnings=0` exit 0、`npm run format:check` 干净、`vitest run` 107 文件 / 1,517 通过（+33，其中第一版提交 +31）、`npm run build` exit 0（1m 25s）、`cargo test` 343 通过 / 0 失败 / 1 忽略（Rust 侧没碰，只复跑基线）。

## v0.8.33（2026-10-20）

### 唤起主窗口的系统快捷键可以改了（批次11）

- 设置 → 快捷键 里多了一行「唤起主窗口（系统级）」：点一下再按下组合键就是改绑，Esc 取消，另有开关和「恢复默认」。
- 原来这条是写死的 Ctrl+Alt+T，被别的软件占了就只在日志里 warn 一声，用户在界面上既看不见也改不了。
- 绑定存在 config.json 里（进备份包），换机/重装后跟着走；默认值仍是 Ctrl+Alt+T，老用户升级后行为不变。
- 改绑必须注册成功才算数：目标键被占用时报明原因并保持原来那条继续生效，不会出现「界面写着新键、系统里没抢到」的静默失效。

### 右键菜单里可以直接把页面搬去别的空间（批次10B，接 ec479d8）

- 页面右键/⋯ 菜单新增「搬到其它空间」：先选目标空间，再选挂在它的哪个页面下，或挂到那个空间的根级；落点按目标空间的真实树缩进展示。
- 搬完自动切到目标空间并打开这一页，不会让人以为页面丢了；旧父页与新父页下的「子页面」块同步更新。
- 只有一个空间时菜单项不出现；数据层守卫（回收站页面、派生视图、父级不属于目标空间）拒绝时，错误原样提示且弹窗保留，可以改落点重试。
- 这次写入会照常触发自动同步（补登进写命令清单）。

### 页面可以搬到其它空间（ec479d8）

- 数据层支持把某个页面连同整棵子树迁到另一个空间：目标侧按新父级的兄弟序列插入，源侧空出的位置自动补位。
- 数据库表的派生视图（多视图）与行详情文档跟着宿主一起走，不会留下「父页在新空间、子页还在旧空间」的半搬状态。
- 守卫：回收站里的页面、以及派生视图本身不允许单独搬；目标空间或目标父级不存在、父级不属于目标空间等情况直接报错，不会静默改数据。

### 日期列不再收下「认不出来的文本」（dc563ab）

- `2024/1/5`、`2024.1.5`、`2024年1月5日`、`2024-1-5` 这类写法统一补零成 `YYYY-MM-DD`；此前交给 `new Date` 解析会按本机时区偏移，东八区的 `2024/1/5` 会落到 1 月 4 日。
- 「下周三见」这类解析不出的文本改成一律按空处理。以前它会原样落进日期列，而日期列的校验只认字符串，结果排序、筛选、日历分组全部失效。
- AI 写日期单元格走同一套归一，认不出时落空值而不是把模型给的原文塞进日期列。
- 偏好镜像补上「这个新版本已经提示过」：不镜像的话换机后同一个已看过的更新会再弹一次。

### 页面别名：一份内容可以有几种叫法（ff23f48、85d9677）

- 页面新增「别名」，右键菜单里编辑；别名与标签一样跟着备份走，导出成 frontmatter、导入时读回。
- 全局搜索、`@` 提及、`[[链接]]` 补全、AI 找页面都认别名：按别名叫出来的页面排在正文命中之前。
- 标题精确匹配优先于别名精确匹配；两页同名或一个别名撞两页时判为歧义，不猜。

### 关联列选定目标表时，对端自动有反向列（1c55259）

- 以前在 A 表建了指向 B 表的关联列，B 表这侧完全看不见；现在选定目标表就在对端自动建一条同名反向列。
- 改指其它表或删除本列时，只清理「我们建过且没人改过配置」的那条；改过配置的一律留着，因为它可能已经进了公式。
- 两张表的写入必须原子，配对走 Rust 单命令完成。

### 公式引用计算列、选择列与关联列时取到看得懂的值（f909db8）

- `{汇总列}` 不再恒为空：每行先算 rollup 与反向关系，再把这些值铺进公式的取数视野。
- 被公式点名的选择列翻成选项名、关联列翻成对端行标题，不再是一串 `opt` id 或裸 UUID。
- 只对公式真正引用到的列额外取数，没有公式字段时零额外开销。

### 编辑器：查找覆盖原子块属性文本、表格标题行列开关、单块重复（e25da05）

- 查找能搜到公式 LaTeX、Mermaid 代码、附件名、图片 alt/caption、数据库视图名；这类命中只跳转与整块高亮，不进替换路径，避免按正文替换把整个原子节点吃掉。
- 表格右键菜单新增切换标题行 / 标题列；块菜单新增「重复这一块」。

### 编辑器：记住并恢复每页的光标与滚动位置（36f0944）

- 回到一个页面时，光标和滚动位置停在你上次离开的地方；记的是「块号 + 块内偏移」，所以别处增删一段不会让位置整体漂移。
- 只在确实回到文档中部、主栏、可编辑且用户还没自己点过时才接管焦点；副栏、只读模式、从搜索或链接跳进来只摆选区不抢焦点。
- 最多记 80 页（LRU），坏数据直接丢弃。

### 搜索：跨页全局替换，先预览再执行（d70cbfd）

- 搜索结果页新增全局替换入口：先列出会被改动的页面与处数，二次确认后才执行，可中途取消。
- 只在单个文本叶子内替换，标记与结构原样保留；页面标题永不改；跨内联段的命中如实标记并交回页内 Ctrl+F。
- 打开着的页面走编辑器事务（可 Ctrl+Z），没打开的读库改写并按节流策略留历史快照。

### 工程：引入 jsdom 组件测试基座（a3a8d94）

- 组件用例可按文件声明 jsdom 环境，新增 `@testing-library/react` 等依赖；默认仍是 node 环境。
- 首批两个真实渲染用例：钉住「改字段类型先弹确认」的闸门，以及 AI 网络调优数值的回填与「Key 留空不清空已存 Key」。

### 编辑器：多选块支持复制、剪切与重复（9f7bbec）

- Shift 扩出的整段多选菜单补上复制 / 剪切 / 重复；剪切先写剪贴板再删，写入失败就什么都不动。
- 单块与多选共用一份块级剪贴板实现；重复时区间夹着半个块或落在被锁定的标题/分割线里一律拒绝。

### AI：写表动作可撤销，网络与检索轮次可配置（447be9f）

- 新增改行、删行两个写动作；行引用按 id 优先、文本唯一匹配，歧义或找不到直接报错，不靠猜改用户数据。
- 写动作附带可序列化的逆操作计划并随会话落库，重启后仍能撤销加行 / 改行 / 删行 / 建页 / 改名。
- AI 直接写库后广播变更，正在显示该表的页面即时重新拉取，不再「应用成功但表格不动」。
- 检索轮数、首帧等待、帧间静默、开流前重试四项从写死改为读设置；本地模型冷启动或自建网关慢时能在设置里自救。
- 首轮报上下文超限时按半预算自动补发（最多两次），并在答案末尾说明本次用了更小的上下文。

### 数据安全：恢复前先深检备份，改类型清空前留快照（01af030）

- 备份恢复逐条目真校验 CRC，并让解出的库过 `integrity_check`；坏档在覆盖本机数据之前就被拒。
- 同步裁决：两侧都改过且活动时间相同时改用指纹大小定序，两台设备不再各自判自己赢。
- 字段改类型要清空整列前，把取值连同类型/options 存进快照，提示条 8 秒内可一键还原。
- 回收站到期清理挂进每小时自动备份的同一循环，前端从未打开过的工作区也会清。
- 附件清理逐条列出未引用资源，可只挪走单个文件，清理后重扫。

### 导入导出保真：硬换行、引用块内子块、列表续行块、toggle 级别（3f09ef5）

- 硬换行导出改成行尾两空格（单元格内改 `<br>`），导入按硬换行标记切段；引用块导入递归成块级内容；列表项内续行块不再丢。
- toggle 的 `<summary>` 带上标题级别并读回；表格单元格不再写对齐注释。
- 导出 HTML 补上高亮/文字颜色、相册图注、子页面块；导入时接住 frontmatter 的 layout，看板/日历页不再退化成表格页。

### 六个视图都能配自己的筛选与排序（d15de9f）

- 筛选/排序条此前只在表格视图挂载，而配置是按视图持久化的：看板、日历、时间线、画廊、列表改不动自己的数据集，只能跳去表格视图改到另一个视图的条件。
- 现在五个非表格视图都挂上共用组件，改完即生效；表格视图行为与外观不变。

### 止血：改类型确认补齐、AI 写入过闸门、补全缺失色阶（35f7807）

- 主题补上 `brand-200/300/400/700/800` 与 `neutral-700`：此前有 41 处 `brand-*`、180 处 `neutral-700` 引用了不存在的类，等于没有样式。
- 删掉 `tailwind.config.js`：Tailwind v4 没有 `@config` 时该文件从不生效，且它 require 了未安装的插件，一旦启用即崩。
- 字段类型菜单补上确认框（改类型在库层是整列清空且无历史可回退）。
- AI 写单元格接类型闸门并拒写只读列；多选缺选项改为补建（不再把裸名称当 id 落库）；数字列拿到全非数字文本时落空值而不是 0。
