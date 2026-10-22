use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 存放 config.json 的独立子目录名（放在 config 系统目录下，避免被"重命名默认数据目录为备份"一起搬走）
const CONFIG_DIR_NAME: &str = "TsFlowyConfig";
/// 备份打包/回档按同一个文件名处理配置文件，故对外可见
pub(crate) const CONFIG_FILE_NAME: &str = "config.json";

// 配置文件的三件事各在一处：结构体与默认值（types.rs）、暴露给设置页的命令（commands.rs）、
// 读写落盘（store.rs）。`commands::files::config::<name>` 这条对外路径靠下面三个 pub use 保持不变。
mod commands;
mod store;
mod types;

pub use commands::*;
pub use store::*;
pub use types::*;

#[cfg(test)]
mod tests;
