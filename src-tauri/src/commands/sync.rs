use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::files::{self, AppConfig};
use crate::db::{Db, DB_FILE};

// 双向同步（#13）——「同步文件夹」方案
//
// 为什么不做内建 WebDAV 客户端：那需要引入 HTTP 栈、处理各家服务端的鉴权/分块/锁协议差异，
// 且无法在本仓库里离线验证。改成"把数据对齐到用户指定的文件夹"后，
// OneDrive / 坚果云 / Dropbox 由它们自己的客户端负责上传下载，
// WebDAV 用户把网盘挂成盘符后选该盘符即可——覆盖面一样，代码量却只有一个复制逻辑。

/// 同步数据落在用户所选目录的这个子目录里，避免和用户自己的文件混在一起
const SYNC_SUBDIR: &str = "TsFlowySync";
/// 冲突副本子目录（两侧都改过时，被舍弃的那一份存这里）
const CONFLICT_DIR: &str = "conflicts";
/// conflicts/ 里保留的份数
const KEEP_CONFLICTS: usize = 5;

#[derive(Serialize)]
pub struct SyncInfo {
    /// 用户选择的同步文件夹（None = 未开启）
    pub dir: Option<String>,
    /// 实际存放数据的目录（<dir>/TsFlowySync）
    pub sync_path: Option<String>,
    /// 上一次同步的动作：none / upload / download / conflict
    pub last_action: Option<String>,
    pub last_time: Option<String>,
}

#[derive(Serialize)]
pub struct SyncOutcome {
    /// none / upload / download / conflict
    pub action: String,
    /// 本机库是否被同步结果替换过（替换后前端必须重新加载数据）
    pub pulled: bool,
    /// 本次双向补齐的附件文件数
    pub assets_copied: usize,
    /// 本次新产生的冲突副本（文件名，位于同步目录的 conflicts/ 下）
    pub conflicts: Vec<String>,
}

/// 命令返回值：本次动作 + 同步后的最新设置（前端一次调用即可刷新展示）
#[derive(Serialize)]
pub struct SyncRunResult {
    #[serde(flatten)]
    pub outcome: SyncOutcome,
    pub info: SyncInfo,
}

/// 同步目录：<用户所选目录>/TsFlowySync
fn sync_dir_of(dir: &str) -> PathBuf {
    PathBuf::from(dir).join(SYNC_SUBDIR)
}

/// 文件内容指纹（分块读取，库可能有上百 MB）
fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = fs::File::open(p).map_err(|e| format!("open {} failed: {e}", p.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 谁该覆盖谁
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    /// 两侧内容一致，无需动作
    Noop,
    /// 本机变了（或首次上传），把本机推上去
    Upload,
    /// 远端变了，把远端拉下来
    Download,
    /// 两侧都变了：远端较新 → 拉远端，本机旧库留副本
    RemoteWins,
    /// 两侧都变了：本机较新 → 推本机，远端旧库留副本
    LocalWins,
}

/// 依据两侧指纹与上次同步基线判断动作。
/// 基线（last_hash）缺失说明是首次同步（或换了同步目录）——此时若两侧内容不同，
/// 无从判断谁改过，退化为"按修改时间取新者，旧者留副本"，绝不静默丢弃任何一侧。
fn decide(local: &str, remote: &str, last: Option<&str>, remote_newer: bool) -> Decision {
    if local == remote {
        return Decision::Noop;
    }
    let local_changed = last != Some(local);
    let remote_changed = last != Some(remote);
    match (local_changed, remote_changed) {
        // 远端没动过：本机的任何差异都推上去，不会覆盖别人的新数据
        (_, false) => Decision::Upload,
        // 本机没动过：拉下来是安全的
        (false, true) => Decision::Download,
        (true, true) => {
            if remote_newer {
                Decision::RemoteWins
            } else {
                Decision::LocalWins
            }
        }
    }
}

/// 单向补齐：src 里有而 dst 里没有的文件复制过去。
/// 附件文件名是纳秒时间戳且从不改写，因此"同名即同内容"，跳过已存在的即可。
fn copy_missing_files(src: &Path, dst: &Path) -> Result<usize, String> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dst).map_err(|e| format!("create {} failed: {e}", dst.display()))?;
    let mut n = 0;
    let entries = fs::read_dir(src).map_err(|e| format!("read {} failed: {e}", src.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        if !from.is_file() {
            continue;
        }
        let to = dst.join(entry.file_name());
        if to.exists() {
            continue;
        }
        fs::copy(&from, &to).map_err(|e| format!("copy {} failed: {e}", to.display()))?;
        n += 1;
    }
    Ok(n)
}

/// 双向补齐 assets/：两侧互相补缺，返回复制的文件总数
fn sync_assets(local_assets: &Path, remote_assets: &Path) -> Result<usize, String> {
    let up = copy_missing_files(local_assets, remote_assets)?;
    let down = copy_missing_files(remote_assets, local_assets)?;
    Ok(up + down)
}

/// 把一份库存成冲突副本（放同步目录的 conflicts/ 下，两边设备都能看到），返回文件名
fn save_conflict(sync_dir: &Path, src: &Path, tag: &str) -> Result<String, String> {
    let dir = sync_dir.join(CONFLICT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create conflicts dir failed: {e}"))?;
    let name = format!("{tag}-{}.db", files::backup_stamp());
    let target = dir.join(&name);
    let _ = fs::remove_file(&target);
    fs::copy(src, &target).map_err(|e| format!("save conflict copy failed: {e}"))?;
    prune_conflicts(&dir);
    Ok(name)
}

/// 只保留 conflicts/ 下最新的 KEEP_CONFLICTS 份（按修改时间），多余删除；
/// 纯增益动作，任何失败都静默跳过，不影响同步结果。
fn prune_conflicts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            Some((m.modified().ok()?, e.path()))
        })
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0)); // 新的在前
    for (_, p) in items.into_iter().skip(KEEP_CONFLICTS) {
        let _ = fs::remove_file(&p);
    }
}

/// 文件的修改时间；取不到时退回 "很久以前"，让另一侧胜出（保守：不拿未知时间去覆盖已知数据）
fn mtime(p: &Path) -> SystemTime {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn info_of(cfg: &AppConfig) -> SyncInfo {
    let dir = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty());
    SyncInfo {
        sync_path: dir
            .as_deref()
            .map(|d| sync_dir_of(d).to_string_lossy().to_string()),
        dir,
        last_action: cfg.sync.last_action.clone(),
        last_time: cfg.sync.last_time.clone(),
    }
}

/// 读取同步设置（展示在设置页）
#[tauri::command]
pub fn get_sync_info(app: tauri::AppHandle) -> Result<SyncInfo, String> {
    Ok(info_of(&files::load_app_config(&app)))
}

/// 设置同步文件夹（传空串 = 关闭同步）。
/// 换目录或首次开启都会清掉上次同步基线：新目录的远端与本机不一定同源，
/// 留着旧基线会把"首次要按时间取新者"误判成"本机改过"。
#[tauri::command]
pub fn set_sync_dir(app: tauri::AppHandle, dir: String) -> Result<SyncInfo, String> {
    let mut cfg = files::load_app_config(&app);
    let next = dir.trim().to_string();
    let next = if next.is_empty() { None } else { Some(next) };
    if cfg.sync.dir != next {
        cfg.sync.last_hash = None;
        cfg.sync.last_action = None;
        cfg.sync.last_time = None;
    }
    cfg.sync.dir = next;
    files::save_app_config(&app, &cfg)?;
    Ok(info_of(&cfg))
}

/// 在系统文件管理器里打开同步目录（尚未同步过时也先建出来，方便用户确认位置）
#[tauri::command]
pub fn open_sync_dir(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = files::load_app_config(&app);
    let Some(dir) = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty()) else {
        return Err("sync dir not configured".to_string());
    };
    let path = sync_dir_of(&dir);
    fs::create_dir_all(&path).map_err(|e| format!("create sync dir failed: {e}"))?;
    files::open_path_in_system(&path)
}

/// 手动双向同步（设置页按钮与前端自动同步定时器共用）。
/// 拉取路径要替换本机库，因此先整体关库、换完再开库——Windows 下连接未关时主库无法改名。
#[tauri::command]
pub async fn run_sync(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
) -> Result<SyncRunResult, String> {
    let mut cfg = files::load_app_config(&app);
    let Some(dir) = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty()) else {
        return Err("sync dir not configured".to_string());
    };
    let data_dir = files::real_data_dir(&app)?;
    let sync_dir = sync_dir_of(&dir);
    fs::create_dir_all(sync_dir.join(CONFLICT_DIR))
        .map_err(|e| format!("create sync dir failed: {e}"))?;

    let local_db = data_dir.join(DB_FILE);
    let remote_db = sync_dir.join(DB_FILE);
    let local_assets = data_dir.join("assets");
    let remote_assets = sync_dir.join("assets");

    // 1) 本机一致快照（WAL 下直接拷主库会丢掉未 checkpoint 的事务）
    let snap = data_dir.join(format!("{DB_FILE}.sync-{}", std::process::id()));
    let _ = fs::remove_file(&snap);
    let result = run_sync_inner(
        &db,
        &local_db,
        &remote_db,
        &snap,
        &local_assets,
        &remote_assets,
        &sync_dir,
        cfg.sync.last_hash.as_deref(),
    );
    let _ = fs::remove_file(&snap);
    let outcome = result?;

    // 2) 落基线：同步结束后两侧内容一致，基线就是远端（=本机）库的指纹
    let last_hash = if remote_db.is_file() {
        sha256_file(&remote_db).ok()
    } else {
        None
    };
    cfg.sync.last_hash = last_hash;
    cfg.sync.last_action = Some(outcome.action.clone());
    cfg.sync.last_time = Some(files::format_local_time(SystemTime::now()));
    // 写配置失败不该让"同步已完成"变成失败：只记日志
    if let Err(e) = files::save_app_config(&app, &cfg) {
        tracing::warn!(error = %e, "sync: save config failed");
    }

    Ok(SyncRunResult {
        outcome,
        info: info_of(&cfg),
    })
}

/// 同步主体（与 AppHandle 解耦，便于单测）。
/// 需要替换本机库时自己负责关库/重开（见 pull_into_local）。
#[allow(clippy::too_many_arguments)]
fn run_sync_inner(
    db: &Db,
    local_db: &Path,
    remote_db: &Path,
    snap: &Path,
    local_assets: &Path,
    remote_assets: &Path,
    sync_dir: &Path,
    last_hash: Option<&str>,
) -> Result<SyncOutcome, String> {
    files::make_db_snapshot(local_db, snap)?;
    let local_hash = sha256_file(snap)?;

    // 首次同步（远端还没有库）：把本机推上去
    if !remote_db.is_file() {
        replace_file(snap, remote_db)?;
        let assets_copied = sync_assets(local_assets, remote_assets)?;
        return Ok(SyncOutcome {
            action: "upload".to_string(),
            pulled: false,
            assets_copied,
            conflicts: Vec::new(),
        });
    }

    let remote_hash = sha256_file(remote_db)?;
    let decision = decide(
        &local_hash,
        &remote_hash,
        last_hash,
        mtime(remote_db) > mtime(local_db),
    );

    let mut conflicts: Vec<String> = Vec::new();
    let mut pulled = false;
    let action = match decision {
        Decision::Noop => "none",
        Decision::Upload => {
            replace_file(snap, remote_db)?;
            "upload"
        }
        Decision::Download => {
            pull_into_local(db, local_db, remote_db)?;
            pulled = true;
            "download"
        }
        Decision::RemoteWins => {
            // 本机这一版作为副本留下（放在同步目录，别的设备也能取回）。
            // 必须用一致性快照 snap：直接拷主库会丢掉还在 WAL 里的未 checkpoint 事务
            conflicts.push(save_conflict(sync_dir, snap, "local")?);
            pull_into_local(db, local_db, remote_db)?;
            pulled = true;
            "conflict"
        }
        Decision::LocalWins => {
            conflicts.push(save_conflict(sync_dir, remote_db, "remote")?);
            replace_file(snap, remote_db)?;
            "conflict"
        }
    };

    let assets_copied = sync_assets(local_assets, remote_assets)?;
    Ok(SyncOutcome {
        action: action.to_string(),
        pulled,
        assets_copied,
        conflicts,
    })
}

/// 覆盖写目标文件（先删再拷：Windows 下 copy 到已存在文件是允许的，但显式删除更直观）
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let _ = fs::remove_file(to);
    fs::copy(from, to).map_err(|e| format!("copy to {} failed: {e}", to.display()))?;
    Ok(())
}

/// 用远端库替换本机库：库还开着时先把远端库拷到同目录临时文件（IO 失败不触碰本机库），
/// 再关库 → stash 旧库 → rename 原子替换；stash 或替换失败自动回滚回同步前状态。
/// 旧库的 -wal/-shm 由 stash 一并移走，否则新库会被旧 WAL 回放损坏。
fn pull_into_local(db: &Db, local_db: &Path, remote_db: &Path) -> Result<(), String> {
    let tmp = local_db.with_file_name(format!("{DB_FILE}.pull-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    fs::copy(remote_db, &tmp).map_err(|e| format!("stage synced db failed: {e}"))?;

    db.close_for_maintenance()?;
    let suffix = files::backup_stamp();
    let result = (|| -> Result<(), String> {
        files::stash_current_db(local_db, &suffix)?;
        fs::rename(&tmp, local_db).map_err(|e| format!("install synced db failed: {e}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
    match result {
        Ok(()) => db.reopen(),
        Err(e) => {
            // 替换没完成：把 stash 的旧库找回来，尽量回到同步前状态（.bak 只作最后手段）
            restore_stashed_db(local_db, &suffix);
            let _ = db.reopen();
            Err(e)
        }
    }
}

/// pull 失败时的回滚：清掉半装的库，把 .bak-{suffix}（含侧车）改回原名。
/// 与 files.rs 导入回滚同思路，但只动数据库文件、不碰 assets。
fn restore_stashed_db(local_db: &Path, suffix: &str) {
    let _ = fs::remove_file(local_db);
    let bak = local_db.with_file_name(format!("{DB_FILE}.bak-{suffix}"));
    if bak.is_file() {
        let _ = fs::rename(&bak, local_db);
    }
    for ext in ["-wal", "-shm"] {
        let from = local_db.with_file_name(format!("{DB_FILE}.bak-{suffix}{ext}"));
        if from.is_file() {
            let to = local_db.with_file_name(format!("{DB_FILE}{ext}"));
            let _ = fs::rename(&from, &to);
        }
    }
}

/// conflicts/ 里的一份冲突副本
#[derive(Serialize)]
pub struct ConflictFile {
    pub name: String,
    pub size: u64,
    /// 修改时间（本地时间串）
    pub modified: String,
}

/// 列出冲突副本（按修改时间倒序）。未开启同步或目录不存在时返回空列表。
#[tauri::command]
pub fn list_sync_conflicts(app: tauri::AppHandle) -> Result<Vec<ConflictFile>, String> {
    let cfg = files::load_app_config(&app);
    let Some(dir) = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let cdir = sync_dir_of(&dir).join(CONFLICT_DIR);
    let Ok(entries) = fs::read_dir(&cdir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<(SystemTime, ConflictFile)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((
                modified,
                ConflictFile {
                    name: e.file_name().to_string_lossy().to_string(),
                    size: m.len(),
                    modified: files::format_local_time(modified),
                },
            ))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, f)| f).collect())
}

/// 在系统文件管理器里打开 conflicts/ 目录
#[tauri::command]
pub fn open_conflicts_dir(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = files::load_app_config(&app);
    let Some(dir) = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty()) else {
        return Err("sync dir not configured".to_string());
    };
    let path = sync_dir_of(&dir).join(CONFLICT_DIR);
    fs::create_dir_all(&path).map_err(|e| format!("create conflicts dir failed: {e}"))?;
    files::open_path_in_system(&path)
}

/// 用一份冲突副本替换本机库（与拉取同一条替换路径：关库→备份旧库→原子换库）。
/// 替换后本机库比远端"新"，下一次同步会自动把它推上去。前端调用成功后必须重载窗口。
#[tauri::command]
pub async fn restore_sync_conflict(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    name: String,
) -> Result<(), String> {
    // 只接受 conflicts/ 下的纯文件名，拒绝任何路径成分
    if name.is_empty() || Path::new(&name).file_name().and_then(|s| s.to_str()) != Some(name.as_str()) {
        return Err("invalid conflict name".to_string());
    }
    let cfg = files::load_app_config(&app);
    let Some(dir) = cfg.sync.dir.clone().filter(|d| !d.trim().is_empty()) else {
        return Err("sync dir not configured".to_string());
    };
    let src = sync_dir_of(&dir).join(CONFLICT_DIR).join(&name);
    if !src.is_file() {
        return Err(format!("conflict file not found: {name}"));
    }
    let local_db = files::real_data_dir(&app)?.join(DB_FILE);
    pull_into_local(&db, &local_db, &src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn write(p: &Path, bytes: &[u8]) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = File::create(p).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn decide_noop_when_both_sides_identical() {
        assert_eq!(decide("a", "a", Some("a"), false), Decision::Noop);
        // 基线缺失但两侧一致：依然是 Noop（不需要任何动作）
        assert_eq!(decide("a", "a", None, true), Decision::Noop);
    }

    #[test]
    fn decide_upload_when_only_local_changed() {
        // 基线 = 远端指纹 → 本机动了
        assert_eq!(decide("new", "old", Some("old"), false), Decision::Upload);
    }

    #[test]
    fn decide_download_when_only_remote_changed() {
        // 基线 = 本机指纹 → 远端动了
        assert_eq!(decide("old", "new", Some("old"), false), Decision::Download);
    }

    #[test]
    fn decide_conflict_when_both_changed_and_picks_newer_mtime() {
        assert_eq!(decide("l", "r", Some("base"), true), Decision::RemoteWins);
        assert_eq!(decide("l", "r", Some("base"), false), Decision::LocalWins);
        // 首次同步（无基线）且两侧不同：退化为按时间取新者，不丢数据
        assert_eq!(decide("l", "r", None, true), Decision::RemoteWins);
        assert_eq!(decide("l", "r", None, false), Decision::LocalWins);
    }

    #[test]
    fn sha256_file_is_stable_and_content_sensitive() {
        let base = std::env::temp_dir().join(format!("tsflowy-sync-hash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let a = base.join("a.bin");
        let b = base.join("b.bin");
        write(&a, b"hello");
        write(&b, b"hello");
        assert_eq!(sha256_file(&a).unwrap(), sha256_file(&b).unwrap());
        write(&b, b"hello!");
        assert_ne!(sha256_file(&a).unwrap(), sha256_file(&b).unwrap());
        assert!(sha256_file(&base.join("missing.bin")).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_assets_copies_both_directions_and_skips_existing() {
        let base = std::env::temp_dir().join(format!("tsflowy-sync-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let local = base.join("local/assets");
        let remote = base.join("remote/assets");
        write(&local.join("1.png"), b"local-only");
        write(&remote.join("2.png"), b"remote-only");
        write(&local.join("3.png"), b"both-sides");
        write(&remote.join("3.png"), b"both-sides");

        let n = sync_assets(&local, &remote).unwrap();

        assert_eq!(n, 2, "只补两侧各缺的那一个");
        assert_eq!(
            fs::read(remote.join("1.png")).unwrap(),
            b"local-only".to_vec()
        );
        assert_eq!(
            fs::read(local.join("2.png")).unwrap(),
            b"remote-only".to_vec()
        );
        // 两侧都有的同名文件不动（附件名带时间戳，同名即同内容）
        assert_eq!(
            fs::read(local.join("3.png")).unwrap(),
            b"both-sides".to_vec()
        );
        // 再跑一次：已补齐，零复制（幂等）
        assert_eq!(sync_assets(&local, &remote).unwrap(), 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_assets_tolerates_missing_dirs() {
        let base =
            std::env::temp_dir().join(format!("tsflowy-sync-assets0-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let local = base.join("local/assets");
        let remote = base.join("remote/assets");
        // 两侧都不存在：不报错、不复制
        assert_eq!(sync_assets(&local, &remote).unwrap(), 0);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn save_conflict_writes_copy_and_prunes_old_ones() {
        let base = std::env::temp_dir().join(format!("tsflowy-sync-conf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let sync_dir = base.join("sync");
        let src = base.join("db.bin");
        write(&src, b"payload");

        // 名字带秒级时间戳，同一秒内多次调用会互相覆盖；这里直接造旧文件验证清理
        let name = save_conflict(&sync_dir, &src, "local").unwrap();
        assert!(name.starts_with("local-") && name.ends_with(".db"));
        assert_eq!(
            fs::read(sync_dir.join(CONFLICT_DIR).join(&name)).unwrap(),
            b"payload".to_vec()
        );
        for i in 0..KEEP_CONFLICTS + 3 {
            write(
                &sync_dir.join(CONFLICT_DIR).join(format!("old-{i}.db")),
                b"x",
            );
        }
        prune_conflicts(&sync_dir.join(CONFLICT_DIR));
        let left = fs::read_dir(sync_dir.join(CONFLICT_DIR)).unwrap().count();
        assert_eq!(left, KEEP_CONFLICTS, "只保留最新 {KEEP_CONFLICTS} 份");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_dir_of_nests_under_chosen_folder() {
        let p = sync_dir_of(r"D:\OneDrive\Apps");
        assert!(p.ends_with(SYNC_SUBDIR));
    }
}
