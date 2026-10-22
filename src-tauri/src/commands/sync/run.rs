// sync 的「跑一轮同步」命令与流程（从 sync/mod.rs 原样搬入，逻辑未改）。
// 文件系统原语、裁决与冲突副本仍留在父模块，这里用 super:: 取。
use super::*;

/// 读取同步设置（展示在设置页）
#[tauri::command]
pub fn get_sync_info(app: tauri::AppHandle) -> Result<SyncInfo, String> {
    Ok(info_of(&files::load_app_config(&app)))
}

/// 最近若干轮同步的历史（新的在前）。手动同步与后台自动同步走同一条链路，
/// 所以这里也是「后台那几次到底做了什么」的唯一出处。
#[tauri::command]
pub fn get_sync_history(app: tauri::AppHandle) -> Vec<SyncHistoryEntry> {
    files::load_app_config(&app).sync.history
}

/// 清空同步历史（只删留档，不动同步目录里的任何数据）
#[tauri::command]
pub fn clear_sync_history(app: tauri::AppHandle) -> Result<(), String> {
    let mut cfg = files::load_app_config(&app);
    cfg.sync.history.clear();
    files::save_app_config(&app, &cfg)
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
/// 同步全程是对库文件/附件的 sha256 与整文件复制（可达数百 MB 的阻塞 IO），
/// 放到 blocking 线程池执行，避免占死 tokio worker 让其它 IPC 命令排队。
#[tauri::command]
pub async fn run_sync(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
) -> Result<SyncRunResult, String> {
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || run_sync_blocking(app, db))
        .await
        .map_err(|e| format!("sync task failed: {e}"))?
}

fn run_sync_blocking(app: tauri::AppHandle, db: SharedDb) -> Result<SyncRunResult, String> {
    let started = std::time::Instant::now();
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
    let hooks = EmitHooks::new(app.clone());
    let result = run_sync_inner(
        &db,
        &local_db,
        &remote_db,
        &snap,
        &data_dir,
        &local_assets,
        &remote_assets,
        &sync_dir,
        cfg.sync.last_hash.as_deref(),
        &hooks,
    );
    let _ = fs::remove_file(&snap);
    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            // 失败也要收掉前端的进度条，否则它会一直停在失败那一步
            hooks.progress(stage::DONE, 1, 1);
            // 失败轮次同样留档：用户看到的只有「同步失败」这句 toast，
            // 事后想知道是哪一轮、卡在哪一步只能靠这里记下的东西
            let mut failed_cfg = files::load_app_config(&app);
            let entry = SyncHistoryEntry {
                time: files::format_local_time(SystemTime::now()),
                action: "failed".to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(e.clone()),
                ..Default::default()
            };
            push_history(&mut failed_cfg, entry);
            if let Err(save_err) = files::save_app_config(&app, &failed_cfg) {
                tracing::warn!(error = %save_err, "sync: save history after failure failed");
            }
            return Err(e);
        }
    };

    // 2) 落基线：同步结束后两侧内容一致，基线就是远端（=本机）库的指纹
    let last_hash = if remote_db.is_file() {
        sha256_file_with(&remote_db, stage::HASH_REMOTE, &SilentHooks).ok()
    } else {
        None
    };
    cfg.sync.last_hash = last_hash;
    cfg.sync.last_action = Some(outcome.action.clone());
    let now = files::format_local_time(SystemTime::now());
    cfg.sync.last_time = Some(now.clone());
    // 什么都没发生的一轮（周期同步最常见结果）不进历史：50 条名额会被一堆 none 挤掉，
    // 反而把用户真正要回看的上传/下载/冲突/失败挤没了
    if outcome.action != "none" || outcome.assets_copied > 0 || outcome.assets_deleted > 0 {
        push_history(
            &mut cfg,
            SyncHistoryEntry {
                time: now,
                action: outcome.action.clone(),
                duration_ms: started.elapsed().as_millis() as u64,
                assets_copied: outcome.assets_copied,
                assets_deleted: outcome.assets_deleted,
                conflicts: outcome.conflicts.clone(),
                error: None,
            },
        );
    }
    // 写配置失败不该让"同步已完成"变成失败：只记日志
    if let Err(e) = files::save_app_config(&app, &cfg) {
        tracing::warn!(error = %e, "sync: save config failed");
    }
    hooks.progress(stage::DONE, 1, 1);

    Ok(SyncRunResult {
        outcome,
        info: info_of(&cfg),
    })
}

/// 历史新的在前，超出上限的旧条目丢弃。
pub(super) fn push_history(cfg: &mut AppConfig, entry: SyncHistoryEntry) {
    cfg.sync.history.insert(0, entry);
    cfg.sync.history.truncate(SYNC_HISTORY_MAX);
}

/// 同步主体（与 AppHandle 解耦，便于单测）。
/// 需要替换本机库时自己负责关库/重开（见 pull_into_local）。
#[allow(clippy::too_many_arguments)]
pub(super) fn run_sync_inner(
    db: &DbInner,
    local_db: &Path,
    remote_db: &Path,
    snap: &Path,
    data_dir: &Path,
    local_assets: &Path,
    remote_assets: &Path,
    sync_dir: &Path,
    last_hash: Option<&str>,
    hooks: &dyn SyncHooks,
) -> Result<SyncOutcome, String> {
    hooks.progress(stage::SNAPSHOT, 0, 0);
    files::make_db_snapshot(local_db, snap)?;
    let local_hash = sha256_file_with(snap, stage::HASH_LOCAL, hooks)?;

    // 墓碑并集 = 本机清单 ∪ 同步目录清单（首次并入时把本机新增项立刻落到远端，防对侧抢先复制）
    let mut tombstones = read_tombstone_file(&sync_dir.join(TOMBSTONE_FILE));
    merge_local_tombstones(data_dir, &mut tombstones);

    // 首次同步（远端还没有库）：把本机推上去
    if !remote_db.is_file() {
        replace_file(snap, remote_db)?;
        let mut outcome = SyncOutcome::new("upload");
        outcome.assets_copied = sync_assets(local_assets, remote_assets, &tombstones, hooks)?;
        outcome.assets_deleted = apply_tombstones(local_assets, remote_assets, &tombstones, hooks);
        outcome.local_activity = activity_label(db_activity_ms(snap));
        write_tombstone_file(&sync_dir.join(TOMBSTONE_FILE), &tombstones)?;
        return Ok(outcome);
    }

    let remote_hash = sha256_file_with(remote_db, stage::HASH_REMOTE, hooks)?;
    // 两侧的活动时间既用于裁决，也回传前端解释「为什么是这一侧胜出」
    let local_activity = db_activity_ms(snap);
    let remote_activity = db_activity_ms(remote_db);
    let decision = decide(
        &local_hash,
        &remote_hash,
        last_hash,
        remote_is_newer(local_activity, remote_activity, &local_hash, &remote_hash),
    );

    let mut outcome = SyncOutcome::new("none");
    match decision {
        Decision::Noop => {}
        Decision::Upload => {
            replace_file(snap, remote_db)?;
            outcome.action = "upload".to_string();
        }
        Decision::Download => {
            pull_into_local(db, local_db, remote_db, hooks)?;
            outcome.pulled = true;
            outcome.action = "download".to_string();
        }
        Decision::RemoteWins => {
            // 本机这一版作为副本留下（放在同步目录，别的设备也能取回）。
            // 必须用一致性快照 snap：直接拷主库会丢掉还在 WAL 里的未 checkpoint 事务
            outcome
                .conflicts
                .push(save_conflict(sync_dir, snap, "local")?);
            pull_into_local(db, local_db, remote_db, hooks)?;
            outcome.pulled = true;
            outcome.conflict_winner = Some("remote".to_string());
            outcome.action = "conflict".to_string();
        }
        Decision::LocalWins => {
            outcome
                .conflicts
                .push(save_conflict(sync_dir, remote_db, "remote")?);
            replace_file(snap, remote_db)?;
            outcome.conflict_winner = Some("local".to_string());
            outcome.action = "conflict".to_string();
        }
    }

    outcome.assets_copied = sync_assets(local_assets, remote_assets, &tombstones, hooks)?;
    outcome.assets_deleted = apply_tombstones(local_assets, remote_assets, &tombstones, hooks);
    outcome.local_activity = activity_label(local_activity);
    outcome.remote_activity = activity_label(remote_activity);
    write_tombstone_file(&sync_dir.join(TOMBSTONE_FILE), &tombstones)?;
    Ok(outcome)
}

/// 用远端库替换本机库：库还开着时先把远端库拷到同目录临时文件（IO 失败不触碰本机库），
/// 再关库 → stash 旧库 → rename 原子替换；stash 或替换失败自动回滚回同步前状态。
/// 旧库的 -wal/-shm 由 stash 一并移走，否则新库会被旧 WAL 回放损坏。
/// 替换成功即刻 hooks.local_replaced()：此时本机库与前端内存数据已经不同源，
/// 后面补附件/写墓碑哪怕失败，前端也必须重载（不能等命令返回值）。
pub(super) fn pull_into_local(
    db: &DbInner,
    local_db: &Path,
    remote_db: &Path,
    hooks: &dyn SyncHooks,
) -> Result<(), String> {
    hooks.progress(stage::REPLACE_DB, 0, 0);
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
        Ok(()) => {
            hooks.local_replaced();
            db.reopen()
        }
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
