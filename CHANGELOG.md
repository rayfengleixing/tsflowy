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
