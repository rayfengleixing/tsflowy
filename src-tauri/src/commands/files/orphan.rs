//! `assets/` 目录的孤儿资源扫描与回收。
//!
//! 背景：图片/附件一旦插入就复制进 `assets/`，而删除页面、删掉图片节点都不会回收文件，
//! 长期使用后目录里会堆积大量再也没人引用的文件（只增不减）。
//!
//! 两条安全约束（本地优先应用里删用户文件是不可逆风险）：
//!   1. 回收是**移动**到 `backups/orphan-assets-<时间戳>/` 而不是删除，挪错了还能人工找回；
//!   2. 真正动手前用同一套判定**重新扫描一次**，跳过在此期间又被引用的文件——
//!      扫描与清理之间隔着用户操作，只信上一次的扫描结果会误伤刚插入的图片。

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::auto_backup::{backup_dir, backup_stamp};
use super::data_dir::app_data_dir;
use super::ASSETS_DIR;
use crate::db::{asset_refs, Db};

#[derive(Serialize)]
pub struct OrphanAsset {
    pub name: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct OrphanScan {
    pub files: Vec<OrphanAsset>,
    pub total_files: usize,
    pub total_bytes: u64,
}

#[derive(Serialize)]
pub struct OrphanPurge {
    /// 实际挪走的文件数（可能少于请求数：中途又被引用或已不存在的不动）
    pub moved: usize,
    pub freed_bytes: u64,
    /// 挪到的目录，便于用户反悔时找回
    pub dest: String,
}

/// 文件名校验：只接受纯文件名（无目录分隔符、无 `..`、非绝对路径、非空）。
/// 名字来自前端，必须挡住路径穿越——否则一次调用就能把 assets 之外的文件挪走。
fn valid_asset_name(name: &str) -> bool {
    let mut comps = Path::new(name).components();
    matches!(comps.next(), Some(Component::Normal(_))) && comps.next().is_none()
}

/// 用当前引用集合筛出 assets 目录下的孤儿文件（名字 + 体积），按名字排序。
fn orphan_names(assets_dir: &Path, blobs: &[String]) -> Result<Vec<(String, u64)>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(assets_dir).map_err(|e| format!("failed to read assets dir: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read assets dir: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let needle = format!("{ASSETS_DIR}/{name}");
        if blobs.iter().any(|blob| blob.contains(&needle)) {
            continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push((name.to_string(), bytes));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 扫描未被任何文档或视图配置引用的资源文件（只读，不动磁盘）。
#[tauri::command]
pub async fn scan_orphan_assets(
    app: tauri::AppHandle,
    db: State<'_, Db>,
) -> Result<OrphanScan, String> {
    let assets_dir = app_data_dir(&app)?.join(ASSETS_DIR);
    if !assets_dir.is_dir() {
        return Ok(OrphanScan {
            files: Vec::new(),
            total_files: 0,
            total_bytes: 0,
        });
    }
    let blobs = {
        let conn = db.read_conn()?;
        asset_refs::reference_blobs(&conn)?
    };
    let files: Vec<OrphanAsset> = orphan_names(&assets_dir, &blobs)?
        .into_iter()
        .map(|(name, bytes)| OrphanAsset { name, bytes })
        .collect();
    Ok(OrphanScan {
        total_files: files.len(),
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        files,
    })
}

/// 把指定文件挪到备份目录（传空 `names` = 清理本次扫描出的全部孤儿资源）。
#[tauri::command]
pub async fn purge_orphan_assets(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    names: Vec<String>,
) -> Result<OrphanPurge, String> {
    for name in &names {
        if !valid_asset_name(name) {
            return Err(format!("invalid asset name: {name}"));
        }
    }

    let assets_dir = app_data_dir(&app)?.join(ASSETS_DIR);
    let blobs = {
        let conn = db.read_conn()?;
        asset_refs::reference_blobs(&conn)?
    };
    // 以「此刻」的引用关系为准，且只处理仍是孤儿的文件
    let orphans: HashSet<String> = orphan_names(&assets_dir, &blobs)?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let targets: Vec<&String> = if names.is_empty() {
        orphans.iter().collect()
    } else {
        names.iter().filter(|n| orphans.contains(*n)).collect()
    };

    let dest: PathBuf = backup_dir(&app)?.join(format!("orphan-assets-{}", backup_stamp()));
    let mut moved = 0usize;
    let mut freed_bytes = 0u64;
    if !targets.is_empty() {
        fs::create_dir_all(&dest).map_err(|e| format!("failed to create backup dir: {e}"))?;
    }
    for name in targets {
        let from = assets_dir.join(name);
        let bytes = fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
        let to = dest.join(name);
        if fs::rename(&from, &to).is_err() {
            // 跨卷或文件被占用时退回复制 + 删除；复制失败则整体报错，不留半成品
            fs::copy(&from, &to).map_err(|e| format!("failed to move asset {name}: {e}"))?;
            fs::remove_file(&from).map_err(|e| format!("failed to remove asset {name}: {e}"))?;
        }
        moved += 1;
        freed_bytes += bytes;
    }

    Ok(OrphanPurge {
        moved,
        freed_bytes,
        dest: dest.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tsflowy-orphan-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn valid_asset_name_rejects_paths_and_traversal() {
        assert!(valid_asset_name("1700000000000000000.png"));
        assert!(valid_asset_name("report.pdf"));

        assert!(!valid_asset_name(""));
        assert!(!valid_asset_name("."));
        assert!(!valid_asset_name(".."));
        assert!(!valid_asset_name("../appflowy.db"));
        assert!(!valid_asset_name("sub/x.png"));
        assert!(!valid_asset_name(r"C:\Windows\notepad.exe"));
        assert!(!valid_asset_name("/etc/passwd"));
    }

    #[test]
    fn orphan_names_keeps_only_unreferenced_files() {
        let dir = temp_dir("scan");
        fs::write(dir.join("used.png"), b"a").unwrap();
        fs::write(dir.join("orphan.png"), b"bb").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap(); // 子目录不是文件，应被跳过

        let blobs = vec![r#"{"src":"assets/used.png"}"#.to_string()];
        let got = orphan_names(&dir, &blobs).unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "orphan.png");
        assert_eq!(got[0].1, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 名字前缀相同但并非同一文件时不能误判（子串匹配必须带上 assets/ 前缀与完整名字）
    #[test]
    fn orphan_names_does_not_confuse_prefix_names() {
        let dir = temp_dir("prefix");
        fs::write(dir.join("170.png"), b"a").unwrap();
        fs::write(dir.join("1700.png"), b"b").unwrap();

        let blobs = vec![r#"{"src":"assets/1700.png"}"#.to_string()];
        let got = orphan_names(&dir, &blobs).unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "170.png");
        let _ = fs::remove_dir_all(&dir);
    }
}
