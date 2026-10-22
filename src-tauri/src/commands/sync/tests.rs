// sync 的用例（从 sync/mod.rs 原样搬入，断言未改）。
use super::run::{push_history, run_sync_inner};
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

/// 不关心进度的调用点（单测里等价于命令层的静默实现）
fn hash_of(p: &Path) -> Result<String, String> {
    sha256_file_with(p, stage::HASH_LOCAL, &SilentHooks)
}

/// 记下收到的进度与替换通知，用于断言「前端能看到什么」
#[derive(Default)]
struct RecordingHooks {
    events: std::sync::Mutex<Vec<(&'static str, u64, u64)>>,
    replaced: std::sync::atomic::AtomicBool,
}

impl SyncHooks for RecordingHooks {
    fn progress(&self, st: &'static str, done: u64, total: u64) {
        self.events.lock().unwrap().push((st, done, total));
    }
    fn local_replaced(&self) {
        self.replaced
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

impl RecordingHooks {
    fn events(&self) -> Vec<(&'static str, u64, u64)> {
        self.events.lock().unwrap().clone()
    }
    fn replaced(&self) -> bool {
        self.replaced.load(std::sync::atomic::Ordering::Relaxed)
    }
}

fn temp_base(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    base
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
fn decide_conflict_when_both_changed_and_picks_newer_activity() {
    assert_eq!(decide("l", "r", Some("base"), true), Decision::RemoteWins);
    assert_eq!(decide("l", "r", Some("base"), false), Decision::LocalWins);
    // 首次同步（无基线）且两侧不同：退化为按时间取新者，不丢数据
    assert_eq!(decide("l", "r", None, true), Decision::RemoteWins);
    assert_eq!(decide("l", "r", None, false), Decision::LocalWins);
}

#[test]
fn remote_is_newer_uses_activity_first() {
    assert!(remote_is_newer(100, 200, "aaa", "bbb"));
    assert!(!remote_is_newer(200, 100, "aaa", "bbb"));
}

#[test]
fn remote_is_newer_breaks_time_tie_by_hash_not_by_side() {
    // 时间相同（含两侧都读不出来都是 0）：赢家的判定只跟两份指纹有关，
    // 所以同一对库在任何一台设备上算出的结果都一致，不会来回互相覆盖
    assert!(remote_is_newer(0, 0, "aaa", "bbb"));
    assert!(!remote_is_newer(0, 0, "bbb", "aaa"));
    assert!(!remote_is_newer(500, 500, "bbb", "aaa"));
    assert!(remote_is_newer(500, 500, "aaa", "bbb"));
}

#[test]
fn sha256_file_is_stable_and_content_sensitive() {
    let base = temp_base("hash");
    let a = base.join("a.bin");
    let b = base.join("b.bin");
    write(&a, b"hello");
    write(&b, b"hello");
    assert_eq!(hash_of(&a).unwrap(), hash_of(&b).unwrap());
    write(&b, b"hello!");
    assert_ne!(hash_of(&a).unwrap(), hash_of(&b).unwrap());
    assert!(hash_of(&base.join("missing.bin")).is_err());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn hashing_reports_byte_progress_from_zero_to_total() {
    let base = temp_base("hashprog");
    // 3 个分块多一点：确保中间帧与收尾帧都出现
    let payload = vec![7u8; 64 * 1024 * 3 + 10];
    let f = base.join("big.bin");
    write(&f, &payload);
    let hooks = RecordingHooks::default();
    let hash = sha256_file_with(&f, stage::HASH_REMOTE, &hooks).unwrap();
    assert_eq!(hash.len(), 64);
    let events = hooks.events();
    assert_eq!(events[0], (stage::HASH_REMOTE, 0, payload.len() as u64));
    assert_eq!(
        *events.last().unwrap(),
        (
            stage::HASH_REMOTE,
            payload.len() as u64,
            payload.len() as u64
        )
    );
    assert!(events.len() >= 5, "分块进度应有多帧: {events:?}");
    // done 单调不减，且不超过 total
    for w in events.windows(2) {
        assert!(w[1].1 >= w[0].1, "进度回退了: {events:?}");
        assert!(w[1].1 <= w[1].2, "进度越过 total: {events:?}");
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn copy_and_sync_assets_skip_tombstoned_files() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-tomb-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let local = base.join("local/assets");
    let remote = base.join("remote/assets");
    write(&local.join("keep.png"), b"keep");
    write(&local.join("dead.png"), b"was-deleted-locally");
    // 远端残留的旧副本：本机 purge 后对侧还留着
    write(&remote.join("gone.png"), b"resurrection-attempt");

    let mut ts: HashSet<String> = HashSet::new();
    ts.insert("assets/dead.png".to_string());
    ts.insert("assets/gone.png".to_string());

    let copied = sync_assets(&local, &remote, &ts, &SilentHooks).unwrap();
    assert_eq!(copied, 1, "只有 keep.png 被补过去，墓碑项跳过");
    assert!(remote.join("keep.png").is_file());
    assert!(!remote.join("dead.png").exists());

    let deleted = apply_tombstones(&local, &remote, &ts, &SilentHooks);
    assert_eq!(deleted, 2, "本机 dead.png 与远端残留 gone.png 都被墓碑清掉");
    assert!(!local.join("dead.png").exists());
    assert!(!remote.join("gone.png").exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn tombstone_manifest_roundtrip_filters_junk() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-tombfile-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let p = base.join(TOMBSTONE_FILE);
    let mut set: HashSet<String> = HashSet::new();
    set.insert("assets/a.png".to_string());
    set.insert("assets/b.pdf".to_string());
    write_tombstone_file(&p, &set).unwrap();
    // 手工塞入越界行/注释/空行再读回，应全被过滤
    let mut raw = fs::read_to_string(&p).unwrap();
    raw.push_str(
        "# comment\n\n../evil.db\nassets\nassets/sub/x.png\nhttp://x/assets/y.png\nassets/ok.txt\n",
    );
    fs::write(&p, raw).unwrap();
    let got = read_tombstone_file(&p);
    assert!(got.contains("assets/a.png"));
    assert!(got.contains("assets/b.pdf"));
    assert!(got.contains("assets/ok.txt"));
    assert_eq!(got.len(), 3, "越界/畸形行必须被丢弃: {got:?}");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn replace_file_is_atomic_and_keeps_target_on_failure() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-replace-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let src = base.join("src.bin");
    let dst = base.join("dst.bin");
    write(&src, b"new-content");
    write(&dst, b"old-content");
    replace_file(&src, &dst).unwrap();
    assert_eq!(fs::read(&dst).unwrap(), b"new-content");
    // 源不存在时失败，且目标保持旧内容（不会先删后拷留空窗）
    let dst2 = base.join("dst2.bin");
    write(&dst2, b"precious");
    assert!(replace_file(&base.join("missing.src"), &dst2).is_err());
    assert_eq!(fs::read(&dst2).unwrap(), b"precious");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn db_activity_ms_reads_max_updated_at_and_survives_junk() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-activity-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let db = base.join("act.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE views (updated_at INTEGER);
             CREATE TABLE database_rows (updated_at INTEGER);
             CREATE TABLE database_cells (updated_at INTEGER);
             CREATE TABLE documents (updated_at INTEGER);
             INSERT INTO views VALUES (100),(500);
             INSERT INTO database_rows VALUES (300);",
    )
    .unwrap();
    drop(conn);
    assert_eq!(db_activity_ms(&db), 500);
    // 非 SQLite 文件 / 缺表：保守返回 0
    let junk = base.join("junk.db");
    write(&junk, b"not a database");
    assert_eq!(db_activity_ms(&junk), 0);
    assert_eq!(db_activity_ms(&base.join("missing.db")), 0);
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

    let hooks = RecordingHooks::default();
    let n = sync_assets(&local, &remote, &HashSet::new(), &hooks).unwrap();

    assert_eq!(n, 2, "只补两侧各缺的那一个");
    // 两个方向共用一根进度条：total = 两侧文件数之和，done 从 0 单调走到 total
    let events = hooks.events();
    assert_eq!(events.first().unwrap().2, 4, "total 应含两侧文件");
    assert_eq!(
        events.last().unwrap(),
        &(stage::ASSETS, 4u64, 4u64),
        "收尾帧必须报满，否则进度条停在半路: {events:?}"
    );
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
    assert_eq!(
        sync_assets(&local, &remote, &HashSet::new(), &SilentHooks).unwrap(),
        0
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn sync_assets_tolerates_missing_dirs() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-assets0-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let local = base.join("local/assets");
    let remote = base.join("remote/assets");
    // 两侧都不存在：不报错、不复制
    assert_eq!(
        sync_assets(&local, &remote, &HashSet::new(), &SilentHooks).unwrap(),
        0
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn save_conflict_writes_copy_and_prunes_old_ones() {
    let base = std::env::temp_dir().join(format!("tsflowy-sync-conf-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let sync_dir = base.join("sync");
    let src = base.join("db.bin");
    write(&src, b"payload");

    let name = save_conflict(&sync_dir, &src, "local").unwrap();
    assert!(name.starts_with("local-") && name.ends_with(".db"));
    assert_eq!(
        fs::read(sync_dir.join(CONFLICT_DIR).join(&name)).unwrap(),
        b"payload".to_vec()
    );
    // 同秒再造一份：纳秒+进程号后缀保证不与上一份同名（旧实现会先删同名再拷）
    let name2 = save_conflict(&sync_dir, &src, "local").unwrap();
    assert_ne!(name, name2, "同秒冲突副本必须各留一份");
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
fn conflict_side_reads_the_name_tag() {
    assert_eq!(conflict_side("local-20261015-1a2b.db"), "local");
    assert_eq!(conflict_side("remote-20261015-1a2b.db"), "remote");
    // 用户自己丢进 conflicts/ 的文件、以及认不出标签的历史命名
    assert_eq!(conflict_side("notes.txt"), "unknown");
    assert_eq!(conflict_side("backup-2026.db"), "unknown");
}

#[test]
fn activity_label_hides_unreadable_timestamps() {
    // 读不出来（非 SQLite / 空表）返回 0 → 不展示，而不是显示 1970 年
    assert_eq!(activity_label(0), None);
    assert_eq!(activity_label(-5), None);
    assert!(activity_label(1_700_000_000_000).is_some());
}

/// 打开一次真 Db 把库建出来（跑完迁移），随后关闭：
/// run_sync_inner 的快照走 VACUUM INTO，只有真库文件才可用
fn make_real_db(path: &Path) {
    let db = crate::db::Db::open(path.to_path_buf());
    drop(db);
}

/// 造一轮同步的目录骨架，返回 (data_dir, sync_dir)
fn sync_dirs(base: &Path) -> (PathBuf, PathBuf) {
    let data_dir = base.join("data");
    let sync_dir = base.join("chosen").join(SYNC_SUBDIR);
    fs::create_dir_all(data_dir.join("assets")).unwrap();
    fs::create_dir_all(sync_dir.join(CONFLICT_DIR)).unwrap();
    (data_dir, sync_dir)
}

/// 把库内数据活动时间抬到未来（模拟另一台设备改过：多了一个页面）
fn bump_activity(db_path: &Path, ms: i64) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute_batch(&format!(
            "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1', 'W', {ms}, {ms});
             INSERT INTO views(id, workspace_id, name, layout, extra, position, created_at, updated_at)
             VALUES ('v1', 'w1', '来自另一台设备', 'document', '{{}}', 0, {ms}, {ms});"
        ))
        .unwrap();
    drop(conn);
}

#[test]
fn remote_wins_replaces_local_db_and_notifies_before_the_command_returns() {
    let base = temp_base("pull");
    let (data_dir, sync_dir) = sync_dirs(&base);
    let local_db = data_dir.join(DB_FILE);
    let remote_db = sync_dir.join(DB_FILE);
    make_real_db(&local_db);
    fs::copy(&local_db, &remote_db).unwrap();
    bump_activity(&remote_db, 4_102_444_800_000); // 2100 年：稳赢本机

    let db = crate::db::Db::open(local_db.clone());
    let hooks = RecordingHooks::default();
    let snap = data_dir.join(format!("{DB_FILE}.snap"));
    let outcome = run_sync_inner(
        &db,
        &local_db,
        &remote_db,
        &snap,
        &data_dir,
        &data_dir.join("assets"),
        &sync_dir.join("assets"),
        &sync_dir,
        None,
        &hooks,
    )
    .unwrap();

    assert_eq!(outcome.action, "conflict");
    assert!(outcome.pulled);
    assert_eq!(outcome.conflict_winner.as_deref(), Some("remote"));
    assert_eq!(outcome.conflicts.len(), 1, "本机旧版要留下一份副本");
    assert_eq!(outcome.local_activity, None, "本机空库读不出活动时间");
    assert!(outcome.remote_activity.is_some(), "远端时间要能展示给用户");
    // 这条是本轮改动的核心：替换发生的那一刻就通知，
    // 否则后续补附件/写墓碑失败时前端拿不到 pulled，会继续往新库写旧数据
    assert!(hooks.replaced(), "库已替换却没发通知");
    let views: i64 = db
        .read_conn()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0))
        .unwrap();
    assert_eq!(views, 1, "重开后的本机库应是被拉下来的那一份");

    let stages: Vec<&str> = hooks.events().iter().map(|e| e.0).collect();
    for st in [
        stage::SNAPSHOT,
        stage::HASH_LOCAL,
        stage::HASH_REMOTE,
        stage::REPLACE_DB,
        stage::ASSETS,
    ] {
        assert!(stages.contains(&st), "缺少阶段进度 {st}: {stages:?}");
    }
    drop(db);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn local_wins_keeps_local_db_and_sends_no_replace_notice() {
    let base = temp_base("push");
    let (data_dir, sync_dir) = sync_dirs(&base);
    let local_db = data_dir.join(DB_FILE);
    let remote_db = sync_dir.join(DB_FILE);
    make_real_db(&local_db);
    fs::copy(&local_db, &remote_db).unwrap();
    // 本机数据活动时间抬到未来：这才是"本机较新"的真判据。
    // 两侧时间相同（都读不出）时的平局现在由指纹定序，赢家不固定，不能再拿来当本机胜的构造。
    bump_activity(&local_db, 4_102_444_800_000); // 2100 年：稳赢远端

    let db = crate::db::Db::open(local_db.clone());
    let hooks = RecordingHooks::default();
    let snap = data_dir.join(format!("{DB_FILE}.snap"));
    // 基线对不上任何一侧 + 本机活动时间更新 → 本机胜，远端旧版存副本
    let outcome = run_sync_inner(
        &db,
        &local_db,
        &remote_db,
        &snap,
        &data_dir,
        &data_dir.join("assets"),
        &sync_dir.join("assets"),
        &sync_dir,
        Some("no-baseline"),
        &hooks,
    )
    .unwrap();

    assert_eq!(outcome.action, "conflict");
    assert!(!outcome.pulled);
    assert_eq!(outcome.conflict_winner.as_deref(), Some("local"));
    assert!(outcome.conflicts[0].starts_with("remote-"));
    assert!(
        outcome.local_activity.is_some(),
        "本机抬过活动时间，判据应读得出来"
    );
    assert!(!hooks.replaced(), "没换库就不该发替换通知");
    let views: i64 = db
        .read_conn()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0))
        .unwrap();
    // 本机那份（含抬活动时间时插入的页面）还在；被远端空库覆盖的话这里是 0
    assert_eq!(views, 1, "本机胜出的路径不能碰本机库文件");
    let stages: Vec<&str> = hooks.events().iter().map(|e| e.0).collect();
    assert!(
        !stages.contains(&stage::REPLACE_DB),
        "没换库却有换库进度: {stages:?}"
    );
    drop(db);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn sync_dir_of_nests_under_chosen_folder() {
    let p = sync_dir_of(r"D:\OneDrive\Apps");
    assert!(p.ends_with(SYNC_SUBDIR));
}

#[test]
fn history_keeps_newest_first_and_trims_the_oldest() {
    let mut cfg = AppConfig::default();
    for i in 0..SYNC_HISTORY_MAX + 5 {
        push_history(
            &mut cfg,
            SyncHistoryEntry {
                time: format!("t{i}"),
                action: "upload".to_string(),
                ..Default::default()
            },
        );
    }
    assert_eq!(cfg.sync.history.len(), SYNC_HISTORY_MAX);
    assert_eq!(
        cfg.sync.history[0].time,
        format!("t{}", SYNC_HISTORY_MAX + 4)
    );
}

/// 历史是后加字段：老 config.json 里没有 history 时必须读成空表
#[test]
fn legacy_config_without_history_reads_as_empty() {
    let cfg: AppConfig = serde_json::from_str(r#"{"sync":{"dir":"D:/s"}}"#).unwrap();
    assert!(cfg.sync.history.is_empty());
}

#[test]
fn db_summary_counts_live_content_and_survives_junk() {
    let base = temp_base("summary");
    fs::create_dir_all(&base).unwrap();
    let db = base.join("s.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE views (is_trash INTEGER);
             CREATE TABLE documents (id TEXT);
             CREATE TABLE database_rows (is_trash INTEGER);
             INSERT INTO views VALUES (0),(0),(1);
             INSERT INTO documents VALUES ('a'),('b');
             INSERT INTO database_rows VALUES (0),(1);",
    )
    .unwrap();
    drop(conn);
    let s = db_summary(&db);
    assert_eq!(
        (s.pages, s.documents, s.rows),
        (2, 2, 1),
        "回收站里的页面/行不该算进对照"
    );
    assert_eq!(s.activity, None);

    // 非 SQLite：全 0 而不是整块预览打不开
    let junk = base.join("junk.db");
    write(&junk, b"not a database");
    let j = db_summary(&junk);
    assert_eq!((j.pages, j.documents, j.rows), (0, 0, 0));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn conflict_file_path_rejects_any_path_component() {
    let cfg = AppConfig {
        sync: files::SyncConfig {
            dir: Some(r"D:\OneDrive\Apps".to_string()),
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(conflict_file_path(&cfg, "local-20261015-1a2b.db").is_ok());
    assert!(conflict_file_path(&cfg, "").is_err());
    assert!(conflict_file_path(&cfg, "../data.db").is_err());
    assert!(conflict_file_path(&cfg, "..\\..\\data.db").is_err());
    assert!(conflict_file_path(&cfg, r"C:\Windows\notepad.exe").is_err());
    assert!(conflict_file_path(&cfg, "sub/x.db").is_err());
    // 未配置同步目录：一份副本也拿不到
    assert!(conflict_file_path(&AppConfig::default(), "local-20261015-1a2b.db").is_err());
}
