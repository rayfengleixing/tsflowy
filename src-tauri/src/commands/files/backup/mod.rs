use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{Db, DB_FILE};

use super::asset::ASSETS_DIR;
use super::auto_backup::{backup_stamp, BACKUP_DIR, PRE_MIGRATION_PREFIX};
use super::config::{config_file_path, CONFIG_FILE_NAME};
use super::data_dir::{app_data_dir, clear_dangling_data_dir_warning, timestamp_suffix};
use super::ensure_dialog_authorized;
use crate::commands::sync::TOMBSTONE_FILE;

// 导入链路里那处 `super::health::deep_check_failure(...)` 原本指 commands::files::health；
// 搬进子模块后 super 变成了 commands::files::backup，故在本模块绑一次名字，让原表达式继续解析。
use super::health;

// 备份归档的「打包 / 恢复」两条链（原 commands/files/backup.rs 按域拆入子模块，逻辑未改）。
// 归档范围（BackupScope / 清单）是两条链共用的语义，连同共用导入留在本文件；
// 子模块用 `use super::*;` 继承这些导入，对外仍保持 `commands::files::backup::<name>` 路径。
mod export;
mod import;

pub use export::*;
pub use import::*;

/// 归档范围：完整备份（库 + 附件 + 设置/墓碑清单），或只打数据库。
/// 迁移前留档用后者：DDL 不动附件与设置，整份复制既慢、又白占磁盘，
/// 还会把 config.json（凭据库不可用时含明文 Key）多复制几份。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackupScope {
    Full,
    DatabaseOnly,
}

impl BackupScope {
    /// 写进归档清单的取值（恢复时据此决定动不动附件）
    fn manifest_value(self) -> &'static str {
        match self {
            BackupScope::Full => "full",
            BackupScope::DatabaseOnly => "database_only",
        }
    }
}

/// 归档内的范围元数据条目名。必须显式记下来：迁移留档只装数据库，
/// 而恢复链路默认整库替换 —— 不标注的话，恢复它会把现有 assets/ 挪走，
/// 用户看到的直接后果就是"附件全没了"。
pub(crate) const MANIFEST_ENTRY: &str = "backup-manifest.json";

#[derive(serde::Deserialize)]
struct BackupManifest {
    scope: String,
}

/// 清单文本 → 范围；解析不出来或旧取值一律按完整备份处理
pub(crate) fn scope_from_manifest_text(text: &str) -> BackupScope {
    match serde_json::from_str::<BackupManifest>(text) {
        Ok(m) if m.scope == BackupScope::DatabaseOnly.manifest_value() => BackupScope::DatabaseOnly,
        _ => BackupScope::Full,
    }
}

/// 读取归档声明的范围：没有清单条目（早期归档）一律按完整备份处理，与历史行为一致。
/// 打不开/解析失败同样回落 Full —— 到这里 zip 已通过校验，坏清单只可能是外部改写的，
/// 按更保守的"完整替换"语义处理即可（后面的校验与回滚仍然兜底）。
fn read_backup_scope(src: &Path) -> BackupScope {
    let Ok(file) = fs::File::open(src) else {
        return BackupScope::Full;
    };
    let Ok(mut archive) = ZipArchive::new(BufReader::new(file)) else {
        return BackupScope::Full;
    };
    let Ok(mut entry) = archive.by_name(MANIFEST_ENTRY) else {
        return BackupScope::Full;
    };
    let mut text = String::new();
    match entry.read_to_string(&mut text) {
        Ok(_) => scope_from_manifest_text(&text),
        Err(_) => BackupScope::Full,
    }
}

#[cfg(test)]
mod tests;
