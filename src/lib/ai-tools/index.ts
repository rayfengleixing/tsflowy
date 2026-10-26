// AI 助手的工具执行层：把模型下发的动作落到本地知识库。
//
// 分两类：
// - 只读取证（search_workspace / list_pages / get_page_content / list_database_fields / query_database）：
//   模型在作答前调用，前端执行后把结果原样喂回模型（agent 循环），不产生确认卡片。
// - 写动作（create_page / set_page_title / add_database_row / update_database_row / delete_database_row）：
//   改动用户数据，默认走确认卡片，用户点「应用」或设置关闭确认时才真正执行
//   （文档编辑 apply_edit 走 ai-editor/ai-locate，不在这里）。
//   每个写动作成功时返回一份 UndoPlan（纯数据逆操作），落进会话 JSON 后重启也能撤销。
//
// 之所以在前端执行：页面树、文档、数据库的权威状态与写入串行化都在前端 store/lib 里，
// Rust 侧再实现一套等于把同一份业务规则抄两遍。
//
// 目录里按职责分八个小文件，index.ts 只做对外 re-export：
// resolve-page（引用解析）/ retrieval（只读取证）/ write-page + write-rows（写动作）/
// write-dispatch（分发）/ undo-plan（逆操作链与 WriteOutcome 契约）/ cell-coerce（值强转）/ specs（工具定义表）。

export { coerceCell } from "./cell-coerce";
export { resolvePage } from "./resolve-page";
export { runRetrievalCall } from "./retrieval";
export { runUndoPlan, sanitizeUndoPlan, type UndoPlan, type WriteOutcome } from "./undo-plan";
export { aiToolSpecs } from "./specs";
export { runWriteAction, type WriteCall } from "./write-dispatch";
