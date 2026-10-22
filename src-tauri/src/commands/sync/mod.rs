use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

use super::files::{self, AppConfig, SyncHistoryEntry, SYNC_HISTORY_MAX};
use crate::db::{Db, DbInner, SharedDb, DB_FILE};

mod run;
pub use run::*;
// pull_into_local 只在父模块内部复用（冲突副本恢复），故显式引入而非靠 pub use 的 glob。
use run::pull_into_local;

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
/// 附件删除墓碑文件：同步目录里的持久清单，防止对侧把已删资产「复活」
/// 备份打包要按同一个名字入档/回档，故对外可见
pub(crate) const TOMBSTONE_FILE: &str = "deleted-assets.txt";
/// 墓碑文件名里 assets 相对路径的分隔符（固定 `/`，跨设备一致）
pub(crate) const TOMBSTONE_PREFIX: &str = "assets/";

/// 同步进度事件（前端订阅见 src/lib/sync-events.ts）：一轮同步要算两次整库 sha256
/// 并复制可达数百 MB 的附件，没有进度就只能对着一个转圈的按钮等。
pub const SYNC_PROGRESS_EVENT: &str = "sync:progress";
/// 本机库已被替换的事件：**在替换完成的那一刻发出**，不等同步命令返回。
/// 因为拉取之后还有补附件/写墓碑/落基线这些步骤可能失败——命令报错时前端拿不到
/// pulled 标志就不会重载，渲染进程会继续把内存里的旧数据写进已经换掉的库。
pub const SYNC_DB_REPLACED_EVENT: &str = "sync:db-replaced";

/// 进度阶段标识（前端按 stage 取文案；与 src/lib/sync-events.ts 的 SYNC_STAGES 对应）
mod stage {
    /// 本机库做一致性快照（WAL 下直接拷主库会丢未 checkpoint 的事务）
    pub const SNAPSHOT: &str = "snapshot";
    pub const HASH_LOCAL: &str = "hash_local";
    pub const HASH_REMOTE: &str = "hash_remote";
    /// 用远端库替换本机库（关库 → 换文件 → 重开）
    pub const REPLACE_DB: &str = "replace_db";
    pub const ASSETS: &str = "assets";
    pub const TOMBSTONES: &str = "tombstones";
    /// 一轮同步的收尾帧：**失败路径也必发**，否则前端的进度条会一直挂着
    pub const DONE: &str = "done";
}

/// SYNC_PROGRESS_EVENT 的负载。total = 0 表示这一步无法预估工作量（单条阻塞调用）。
#[derive(Serialize, Clone)]
pub struct SyncProgress {
    pub stage: &'static str,
    pub done: u64,
    pub total: u64,
}

/// 同步过程的可观测性回调：命令层注入会发 Tauri 事件的实现，单测用默认空实现，
/// 这样 run_sync_inner 仍然与 AppHandle 解耦。
pub(crate) trait SyncHooks {
    fn progress(&self, _stage: &'static str, _done: u64, _total: u64) {}
    /// 本机库文件已换掉（内容与内存里的前端数据不再同源）
    fn local_replaced(&self) {}
}

/// 什么都不通知的实现（单测、以及只想要指纹而不关库的调用方）
struct SilentHooks;

impl SyncHooks for SilentHooks {}

/// 向所有窗口广播进度与替换事件
struct EmitHooks {
    app: tauri::AppHandle,
    /// 上一次发出进度的 done 值，用于节流
    last: std::cell::Cell<u64>,
}

impl EmitHooks {
    fn new(app: tauri::AppHandle) -> EmitHooks {
        EmitHooks {
            app,
            last: std::cell::Cell::new(0),
        }
    }
}

impl SyncHooks for EmitHooks {
    fn progress(&self, stage: &'static str, done: u64, total: u64) {
        // done == 0 一定是新阶段的起点（顺带重置节流基准）；收尾帧必发，
        // 中间帧约 40 帧封顶——百 MB 的库按 64KiB 分块会有上万块，全发会淹掉事件通道
        let terminal = total == 0 || done == 0 || done >= total;
        if !terminal && done - self.last.get() < total / 40 {
            return;
        }
        self.last.set(done);
        let _ = self
            .app
            .emit(SYNC_PROGRESS_EVENT, SyncProgress { stage, done, total });
    }

    fn local_replaced(&self) {
        let _ = self.app.emit(SYNC_DB_REPLACED_EVENT, ());
    }
}

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
    /// 本次按墓碑删除的附件文件数（两侧合计）
    pub assets_deleted: usize,
    /// 本次新产生的冲突副本（文件名，位于同步目录的 conflicts/ 下）
    pub conflicts: Vec<String>,
    /// 发生冲突时保留下来的一侧：local = 本机胜（远端旧版存成副本），remote = 远端胜
    pub conflict_winner: Option<String>,
    /// 本机库内最近一次数据活动的时间（裁决依据，不是文件 mtime）
    pub local_activity: Option<String>,
    /// 远端库内最近一次数据活动的时间
    pub remote_activity: Option<String>,
}

/// 命令返回值：本次动作 + 同步后的最新设置（前端一次调用即可刷新展示）
#[derive(Serialize)]
pub struct SyncRunResult {
    #[serde(flatten)]
    pub outcome: SyncOutcome,
    pub info: SyncInfo,
}

impl SyncOutcome {
    /// 除 action 外全为默认值；后续按步骤补计数与冲突信息
    fn new(action: &str) -> SyncOutcome {
        SyncOutcome {
            action: action.to_string(),
            pulled: false,
            assets_copied: 0,
            assets_deleted: 0,
            conflicts: Vec::new(),
            conflict_winner: None,
            local_activity: None,
            remote_activity: None,
        }
    }
}

/// 同步目录：<用户所选目录>/TsFlowySync
fn sync_dir_of(dir: &str) -> PathBuf {
    PathBuf::from(dir).join(SYNC_SUBDIR)
}

/// 文件内容指纹（分块读取，库可能有上百 MB），并把「已读字节 / 文件总字节」报给进度回调。
/// 整库哈希是大库同步里最耗时的两步，值得单独有进度；不需要报进度时传 SilentHooks。
fn sha256_file_with(p: &Path, st: &'static str, hooks: &dyn SyncHooks) -> Result<String, String> {
    let mut f = fs::File::open(p).map_err(|e| format!("open {} failed: {e}", p.display()))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut done = 0u64;
    hooks.progress(st, 0, total);
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        hooks.progress(st, done, total);
    }
    hooks.progress(st, total, total);
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

/// 两侧都改过时的裁决：先看数据活动时间；时间相同（含两侧都读不出来、都是 0 的情况）
/// 改用指纹大小定序。恒定判本机胜会让两台设备在「谁覆盖谁」上永远打架：
/// A 同步完推上去，B 再同步时照样判自己赢，来回覆盖。指纹比较对每台设备都算出同一个赢家。
fn remote_is_newer(
    local_activity: i64,
    remote_activity: i64,
    local_hash: &str,
    remote_hash: &str,
) -> bool {
    if remote_activity != local_activity {
        return remote_activity > local_activity;
    }
    remote_hash > local_hash
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

/// 目录里的文件数（只数一层，附件目录不分层）。目录不存在/读不了记 0，
/// 它只用于估算进度，不能把同步本身带崩。
fn count_files(dir: &Path) -> u64 {
    match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().filter(|e| e.path().is_file()).count() as u64,
        Err(_) => 0,
    }
}

/// 单向补齐：src 里有而 dst 里没有、且未被墓碑声明删除的文件复制过去。
/// 附件文件名是纳秒时间戳且从不改写，因此"同名即同内容"，跳过已存在的即可。
/// base/total 让两个方向共用一根进度条（total 为两侧文件数之和）。
fn copy_missing_files(
    src: &Path,
    dst: &Path,
    tombstones: &HashSet<String>,
    hooks: &dyn SyncHooks,
    base: u64,
    total: u64,
) -> Result<usize, String> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dst).map_err(|e| format!("create {} failed: {e}", dst.display()))?;
    let mut n = 0;
    let entries = fs::read_dir(src).map_err(|e| format!("read {} failed: {e}", src.display()))?;
    for (i, entry) in entries.flatten().enumerate() {
        let from = entry.path();
        if !from.is_file() {
            continue;
        }
        hooks.progress(stage::ASSETS, base + i as u64, total);
        let Some(file_name) = from.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if tombstones.contains(&format!("{TOMBSTONE_PREFIX}{file_name}")) {
            continue;
        }
        let to = dst.join(file_name);
        if to.exists() {
            continue;
        }
        fs::copy(&from, &to).map_err(|e| format!("copy {} failed: {e}", to.display()))?;
        n += 1;
    }
    Ok(n)
}

/// 双向补齐 assets/：两侧互相补缺（跳过墓碑中的文件），返回复制的文件总数
fn sync_assets(
    local_assets: &Path,
    remote_assets: &Path,
    tombstones: &HashSet<String>,
    hooks: &dyn SyncHooks,
) -> Result<usize, String> {
    let up_total = count_files(local_assets);
    let total = up_total + count_files(remote_assets);
    let up = copy_missing_files(local_assets, remote_assets, tombstones, hooks, 0, total)?;
    let down = copy_missing_files(
        remote_assets,
        local_assets,
        tombstones,
        hooks,
        up_total,
        total,
    )?;
    hooks.progress(stage::ASSETS, total, total);
    Ok(up + down)
}

// ———— 附件删除墓碑 ————
// 背景：orphan purge / 数据修复把文件从 assets/ 挪走后，同步目录里的旧副本还在，
// 下一轮双向补齐会把它复制回来——附件被「复活」。墓碑是一份持久清单：
// 本机删除资源时追加到 <data_dir>/deleted-assets.txt（纯相对路径，一行一个），
// 同步时两侧清单取并集，据此删除两台机器上的对应文件，并把并集写回同步目录，
// 让之后接入的第三台设备也遵守同一份记录。

/// 墓碑清单里只接受 `assets/<纯文件名>` 形态；注释行（# 开头）与任何越界路径丢弃。
fn normalize_tombstone_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let name = line.strip_prefix(TOMBSTONE_PREFIX)?;
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains(":")
        || Path::new(name).components().count() != 1
    {
        return None;
    }
    Some(line.to_string())
}

fn read_tombstone_file(p: &Path) -> HashSet<String> {
    let Ok(s) = fs::read_to_string(p) else {
        return HashSet::new();
    };
    s.lines().filter_map(normalize_tombstone_line).collect()
}

/// 原子写墓碑清单（换行结尾，逐行一词，便于对侧人读与行级 diff）
fn write_tombstone_file(p: &Path, set: &HashSet<String>) -> Result<(), String> {
    let mut lines: Vec<&str> = set.iter().map(String::as_str).collect();
    lines.sort_unstable();
    let content = format!("{}\n", lines.join("\n"));
    atomic_write_bytes(p, content.as_bytes())
}

/// 本机删除附件后追加墓碑（供 orphan purge 等调用）。
/// data_dir 为数据目录；清单不存在或写失败返回 Err（调用方记日志即可，不阻断删除）。
pub(crate) fn append_local_tombstones(
    app: &tauri::AppHandle,
    rel_paths: &[String],
) -> Result<(), String> {
    if rel_paths.is_empty() {
        return Ok(());
    }
    let data_dir = files::real_data_dir(app)?;
    let path = data_dir.join(TOMBSTONE_FILE);
    let mut set = read_tombstone_file(&path);
    for rel in rel_paths {
        if let Some(norm) = normalize_tombstone_line(rel) {
            set.insert(norm);
        }
    }
    let mut lines: Vec<&str> = set.iter().map(String::as_str).collect();
    lines.sort_unstable();
    fs::write(&path, format!("{}\n", lines.join("\n")))
        .map_err(|e| format!("write tombstone manifest failed: {e}"))
}

/// 读取本机墓碑并并入并集集合（去重），供同步主流程使用。
fn merge_local_tombstones(data_dir: &Path, union: &mut HashSet<String>) -> usize {
    let before = union.len();
    union.extend(read_tombstone_file(&data_dir.join(TOMBSTONE_FILE)));
    union.len() - before
}

/// 按并集墓碑删除两侧 assets 里的对应文件，返回删除数（每台文件只计一次）。
fn apply_tombstones(
    local_assets: &Path,
    remote_assets: &Path,
    tombstones: &HashSet<String>,
    hooks: &dyn SyncHooks,
) -> usize {
    let total = tombstones.len() as u64;
    let mut deleted = 0usize;
    hooks.progress(stage::TOMBSTONES, 0, total);
    for (i, rel) in tombstones.iter().enumerate() {
        let Some(name) = rel.strip_prefix(TOMBSTONE_PREFIX) else {
            continue;
        };
        for dir in [local_assets, remote_assets] {
            let p = dir.join(name);
            if p.is_file() && fs::remove_file(&p).is_ok() {
                deleted += 1;
            }
        }
        hooks.progress(stage::TOMBSTONES, i as u64 + 1, total);
    }
    deleted
}

/// 原子写字节内容：同目录临时文件 + rename 覆盖（与 replace_file 同语义，用于内存内容）。
fn atomic_write_bytes(p: &Path, bytes: &[u8]) -> Result<(), String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = p.with_file_name(format!(
        "{}.tmp-{}-{}",
        p.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id(),
        unique
    ));
    let result = (|| -> Result<(), String> {
        fs::write(&tmp, bytes).map_err(|e| format!("write tmp for {} failed: {e}", p.display()))?;
        if p.exists() {
            fs::remove_file(p).map_err(|e| format!("remove {} failed: {e}", p.display()))?;
        }
        fs::rename(&tmp, p).map_err(|e| format!("install {} failed: {e}", p.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 原子替换目标文件：先拷到同目录临时文件，再 rename 覆盖。
/// 网盘/资源管理器任何时刻看到的都是"旧完整文件"或"新完整文件"，
/// 不会出现先删后拷之间的空窗（网盘可能把空窗同步出去导致远端库丢失）。
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = to.with_file_name(format!(
        "{}.new-{}-{}",
        to.file_name().and_then(|s| s.to_str()).unwrap_or("target"),
        std::process::id(),
        unique
    ));
    let result = (|| -> Result<(), String> {
        fs::copy(from, &tmp).map_err(|e| format!("stage {} failed: {e}", to.display()))?;
        // Windows rename 不覆盖已存在文件：先移除旧文件，移除失败即中止（此时目标文件仍完好）
        if to.exists() {
            fs::remove_file(to).map_err(|e| format!("remove {} failed: {e}", to.display()))?;
        }
        fs::rename(&tmp, to).map_err(|e| format!("install {} failed: {e}", to.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 把一份库存成冲突副本（放同步目录的 conflicts/ 下，两边设备都能看到），返回文件名。
/// 名字带秒级时间戳 + 纳秒/进程号后缀：同一秒内两次冲突不会互相覆盖。
fn save_conflict(sync_dir: &Path, src: &Path, tag: &str) -> Result<String, String> {
    let dir = sync_dir.join(CONFLICT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create conflicts dir failed: {e}"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("{tag}-{}-{:x}.db", files::backup_stamp(), nanos % 1_000_000);
    let target = dir.join(&name);
    // 原子替换语义：目标同名文件本不应存在；仍先原子写，绝不"先删同名再慢慢拷"
    let tmp = dir.join(format!("{name}.tmp-{}", std::process::id()));
    fs::copy(src, &tmp).map_err(|e| format!("save conflict copy failed: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("install conflict copy failed: {e}")
    })?;
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
    items.sort_by_key(|item| std::cmp::Reverse(item.0)); // 新的在前
    for (_, p) in items.into_iter().skip(KEEP_CONFLICTS) {
        let _ = fs::remove_file(&p);
    }
}

/// 库内最近一次数据活动的时间戳（毫秒）。
/// 冲突裁决用它而不是文件系统 mtime：后者既受跨设备时钟偏差影响，
/// 又只在 WAL checkpoint 时才更新到主库文件——拿它比新旧会把更新的本机版误判成旧。
/// 读不出（非 SQLite 文件/缺表/损坏）返回 0，让另一侧胜出（保守：不拿未知覆盖已知）。
fn db_activity_ms(db_path: &Path) -> i64 {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return 0;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let max_of = |sql: &str| -> Option<i64> {
        conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
    };
    [
        max_of("SELECT MAX(updated_at) FROM views"),
        max_of("SELECT MAX(updated_at) FROM database_rows"),
        max_of("SELECT MAX(updated_at) FROM database_cells"),
        max_of("SELECT MAX(updated_at) FROM documents"),
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(0)
}

/// 数据活动时间戳（毫秒）→ 本地时间串。0 表示读不出来（非 SQLite / 空表），不展示。
fn activity_label(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    let t = UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    Some(files::format_local_time(t))
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

/// conflicts/ 里的一份冲突副本
#[derive(Serialize)]
pub struct ConflictFile {
    pub name: String,
    pub size: u64,
    /// 修改时间（本地时间串）：这是「副本被写下的时间」
    pub modified: String,
    /// 被舍弃的是哪一侧的数据：local = 本机那一版，remote = 同步文件夹那一版
    pub side: &'static str,
    /// 这份副本里最后一次数据活动的时间——用户判断"这份还值不值得取回"的依据
    pub activity: Option<String>,
}

/// 冲突副本文件名里的来源标签（`local-<时间戳>-<后缀>.db`，见 save_conflict）。
/// 认不出来只会退化成"未知来源"，不影响列表展示。
fn conflict_side(name: &str) -> &'static str {
    match name.split('-').next() {
        Some("local") => "local",
        Some("remote") => "remote",
        _ => "unknown",
    }
}

/// 列出冲突副本（按修改时间倒序）。未开启同步或目录不存在时返回空列表。
/// 每份副本都会被只读打开一次取数据活动时间，属于阻塞 IO → 走 blocking 线程。
#[tauri::command]
pub async fn list_sync_conflicts(app: tauri::AppHandle) -> Result<Vec<ConflictFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_conflicts_blocking(&app))
        .await
        .map_err(|e| format!("list conflicts failed: {e}"))?
}

fn list_conflicts_blocking(app: &tauri::AppHandle) -> Result<Vec<ConflictFile>, String> {
    let cfg = files::load_app_config(app);
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
            // save_conflict 的中途残留（改名前崩溃）不算一份副本
            let name = e.file_name().to_string_lossy().to_string();
            if name.contains(".tmp-") {
                return None;
            }
            let path = e.path();
            let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((
                modified,
                ConflictFile {
                    activity: activity_label(db_activity_ms(&path)),
                    side: conflict_side(&name),
                    modified: files::format_local_time(modified),
                    name,
                    size: m.len(),
                },
            ))
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.0));
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

/// conflicts/ 下某个副本的路径：只接受纯文件名，拒绝任何路径成分（`..`、绝对路径、盘符）。
fn conflict_file_path(cfg: &AppConfig, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name) {
        return Err("invalid conflict name".to_string());
    }
    let dir = cfg
        .sync
        .dir
        .clone()
        .filter(|d| !d.trim().is_empty())
        .ok_or_else(|| "sync dir not configured".to_string())?;
    Ok(sync_dir_of(&dir).join(CONFLICT_DIR).join(name))
}

/// 一份库的粗粒度概览。恢复冲突副本前，用户要判断的是"这份里有没有我本机缺的东西"，
/// 数量对比 + 最后一次数据活动时间就够了；逐行 diff 属于记录级合并，明确不做。
/// 表缺失/不是 SQLite 时全为 0（对照仍然显示得出来，不至于整块预览打不开）。
#[derive(Default, Serialize)]
pub struct DbSummary {
    pub pages: i64,
    pub documents: i64,
    pub rows: i64,
    pub activity: Option<String>,
}

pub(crate) fn db_summary(path: &Path) -> DbSummary {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return DbSummary::default();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    DbSummary {
        pages: count("SELECT COUNT(*) FROM views WHERE is_trash = 0"),
        documents: count("SELECT COUNT(*) FROM documents"),
        rows: count("SELECT COUNT(*) FROM database_rows WHERE is_trash = 0"),
        activity: activity_label(db_activity_ms(path)),
    }
}

/// 冲突副本与本机当前库的并排对照
#[derive(Serialize)]
pub struct ConflictPreview {
    pub name: String,
    /// local = 被舍弃的本机那一版，remote = 同步目录里被舍弃的那一版
    pub side: &'static str,
    pub size: u64,
    pub modified: String,
    pub copy: DbSummary,
    pub local: DbSummary,
}

/// 预览一份冲突副本（只读，不碰本机库）：恢复按钮前先看清两边各有什么。
#[tauri::command]
pub async fn preview_sync_conflict(
    app: tauri::AppHandle,
    name: String,
) -> Result<ConflictPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_conflict_blocking(&app, &name))
        .await
        .map_err(|e| format!("preview conflict failed: {e}"))?
}

fn preview_conflict_blocking(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<ConflictPreview, String> {
    let cfg = files::load_app_config(app);
    let path = conflict_file_path(&cfg, name)?;
    let meta = path
        .metadata()
        .map_err(|_| format!("conflict file not found: {name}"))?;
    let local_db = files::real_data_dir(app)?.join(DB_FILE);
    Ok(ConflictPreview {
        copy: db_summary(&path),
        local: db_summary(&local_db),
        modified: meta
            .modified()
            .map(files::format_local_time)
            .unwrap_or_default(),
        size: meta.len(),
        side: conflict_side(name),
        name: name.to_string(),
    })
}

/// 用一份冲突副本替换本机库（与拉取同一条替换路径：关库→备份旧库→原子换库）。
/// 换库瞬间会广播 sync:db-replaced，前端据此重载，无需等这里的返回值。
#[tauri::command]
pub async fn restore_sync_conflict(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    name: String,
) -> Result<(), String> {
    let cfg = files::load_app_config(&app);
    let src = conflict_file_path(&cfg, &name)?;
    if !src.is_file() {
        return Err(format!("conflict file not found: {name}"));
    }
    let local_db = files::real_data_dir(&app)?.join(DB_FILE);
    // 与 run_sync 同理：拷贝数百 MB + 关库重开是阻塞 IO，不占 tokio worker
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || {
        let hooks = EmitHooks::new(app);
        pull_into_local(&db, &local_db, &src, &hooks)
    })
    .await
    .map_err(|e| format!("conflict restore task failed: {e}"))?
}

#[cfg(test)]
mod tests;
