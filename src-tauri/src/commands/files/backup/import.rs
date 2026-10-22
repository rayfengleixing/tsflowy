// 恢复与导入：校验归档、把现有库与附件改名让位（.bak-时间戳）、解压覆盖，失败可回滚
use super::*;

/// 从 zip 备份恢复：先把现有 db（含 -wal/-shm）+ assets 改名备份（.bak-时间戳），再解 zip 覆盖。
/// 旧 db 的 -wal/-shm 必须一并移走：新恢复的库若被旧 WAL 回放会直接损坏。
/// 恢复前后对 Db 做整体 close/reopen：Windows 下连接未关时主库/-wal 无法改名/覆盖；
/// 也因此不再要求"先关应用再导入"。
#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    source_path: String,
) -> Result<(), String> {
    // 校验 + 解压整库与全部附件是重阻塞 IO，放 blocking 线程池执行
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || import_backup_blocking(app, db, source_path))
        .await
        .map_err(|e| format!("import task failed: {e}"))?
}

fn import_backup_blocking(
    app: tauri::AppHandle,
    db: crate::db::SharedDb,
    source_path: String,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &source_path)?;
    restore_backup_from(&app, db, Path::new(&source_path))
}

/// 把当前 config.json 复制一份进数据目录（与 db/assets 同属 `*.bak-<suffix>` 那一组，
/// 因此 prune_stale_backups 会连着一起清理，不需要另设一套保留策略）。
/// 用复制而不是改名：配置目录在 %APPDATA%，数据目录常被挪到别的盘，跨卷 rename 会失败。
/// 原本没有配置文件时什么都不做——回滚据此删掉刚恢复出来的配置。
fn stash_config_copy(config_target: &Path, data_dir: &Path, suffix: &str) -> Result<(), String> {
    if !config_target.is_file() {
        return Ok(());
    }
    let bak = data_dir.join(format!("{CONFIG_FILE_NAME}.bak-{suffix}"));
    fs::copy(config_target, &bak)
        .map(|_| ())
        .map_err(|e| format!("backup config.json failed: {e}"))
}

/// 恢复主体：关库 → 校验/导入 → 重开。
/// 路径安全性由调用方负责（对话框白名单校验，或 Rust 侧从数据目录内拼好的纯文件名）。
/// 备份列表的「恢复」命令走这里，与「导入备份」完全同一条链路，不另造恢复语义。
pub(crate) fn restore_backup_from(
    app: &tauri::AppHandle,
    db: crate::db::SharedDb,
    source: &Path,
) -> Result<(), String> {
    db.close_for_maintenance()?;
    let result = import_backup_into(&app_data_dir(app)?, source, &config_file_path());
    match result {
        Ok(()) => {
            // 导入成功即数据目录已重建（悬空联接被 create_dir_all 治好），告警随之失效
            clear_dangling_data_dir_warning();
            db.reopen()
        }
        // 失败路径也重开：恢复失败时应用应继续可用（原数据仍在 .bak 或原位）
        Err(e) => {
            let _ = db.reopen();
            Err(e)
        }
    }
}

/// 导入实现（数据目录与配置文件落点显式传入便于测试）：校验 → stash → 解压 → 失败回滚
pub(super) fn import_backup_into(
    data_dir: &Path,
    src: &Path,
    config_target: &Path,
) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;

    if !src.is_file() {
        return Err(format!("backup file not found: {}", src.display()));
    }

    // 先校验后破坏：zip 必须能打开、含数据库文件、无路径穿越条目，全部通过才动现有数据。
    // 否则选错文件（非 zip / 无 db）会留下一个"全新空库"，原数据只剩 .bak 且应用内无法恢复。
    validate_backup_zip(src)?;
    // 只装数据库的归档（迁移留档）恢复时不动附件与设置：它们根本不在这份归档里，
    // 按完整替换语义把它们挪走就等于"恢复完成后附件全没了"
    let scope = read_backup_scope(src);

    // 备份现有数据（失败时统一回滚）
    let suffix = timestamp_suffix();
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
    stash_current_db(&db, &suffix)?;
    if scope == BackupScope::Full && assets_dir.is_dir() {
        let bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
        fs::rename(&assets_dir, &bak).map_err(|e| format!("backup assets failed: {e}"))?;
    }
    // 设置文件与 db/assets 同一时间戳分组：旧版本归档里没有 config.json，
    // stash 后解压也不会写回配置目录，等价于"这次不动设置"
    if scope == BackupScope::Full {
        stash_config_copy(config_target, data_dir, &suffix)?;
    }

    // 解 zip；任何一步失败都回滚到导入前状态（含解压了一半的文件）
    if let Err(e) = extract_backup_zip(src, data_dir, config_target) {
        rollback_import_stash(data_dir, config_target, &suffix, scope);
        return Err(e);
    }
    // 必须有数据库文件，否则视为恢复失败，回滚备份
    if !db.is_file() {
        rollback_import_stash(data_dir, config_target, &suffix, scope);
        return Err(format!(
            "backup zip does not contain valid database file (previous data kept at *.bak-{suffix})"
        ));
    }
    // 恢复成功：清掉更早的历史备份（导入会不断产生 .bak-*，不清理会无限堆积）
    prune_stale_backups(data_dir);
    Ok(())
}

/// 保留的历史备份组数（同一次导入产生的 db/assets 备份后缀相同，算一组）
const KEEP_BAK_GROUPS: usize = 3;

/// 清理数据目录里过期的 `*.bak-<时间戳>` 备份，只留最新 KEEP_BAK_GROUPS 组。
/// 纯增益动作：目录读不了、条目名不合规、删除失败都静默跳过，绝不因此中断主流程。
pub(super) fn prune_stale_backups(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    let mut items: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 形如 appflowy.db.bak-1730000000、appflowy.db.bak-1730000000-wal、assets.bak-1730000000
        let Some(suffix) = name.rsplit_once(".bak-").map(|(_, s)| s) else {
            continue;
        };
        let Some(stamp) = suffix.split('-').next().and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        items.push((stamp, entry.path()));
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.0)); // 新的在前
    let mut kept: Vec<u64> = Vec::new();
    for (stamp, path) in items {
        if kept.contains(&stamp) {
            continue; // 同组的其余文件跟着这一组一起留
        }
        if kept.len() < KEEP_BAK_GROUPS {
            kept.push(stamp);
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 导入前置校验：能打开、无路径穿越条目、含数据库文件，且**每个条目真能解出来**
/// （zip 在读取时校验 CRC，只翻中央目录发现不了正文被截断/篡改的档），
/// 解出的库还要过一遍 `PRAGMA integrity_check`。
///
/// 为什么查到这一步：恢复是「拿这份档覆盖本机现有数据」，而校验发生在覆盖之前，
/// 是唯一还能反悔的时机。此前只看中央目录有没有 data.db，
/// 半截下载、磁盘坏道、被压缩工具改写过的归档都能一路放行，直到库被换掉才暴露。
pub(super) fn validate_backup_zip(src: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("invalid zip archive: {e}"))?;
    let mut has_db = false;
    // 库解到同目录的临时文件里查（数据目录可能跨盘，落在归档旁边最稳）
    let probe = src.with_extension(format!("integrity-{}.db", std::process::id()));
    let result = (|| -> Result<(), String> {
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("read zip entry: {e}"))?;
            let name = entry.name().to_string();
            let rel = Path::new(&name);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(format!("invalid zip entry (path traversal): {name}"));
            }
            if name == DB_FILE {
                has_db = true;
                // f 在本轮结束即关闭：Windows 上文件还开着就没法再被 SQLite 检查/删除
                let mut f =
                    fs::File::create(&probe).map_err(|e| format!("create probe file: {e}"))?;
                std::io::copy(&mut entry, &mut f).map_err(|e| format!("unpack database: {e}"))?;
            } else {
                // 其余条目同样要读完一遍：CRC 只在数据被消费时才校验
                std::io::copy(&mut entry, &mut std::io::sink())
                    .map_err(|e| format!("unpack entry {name}: {e}"))?;
            }
        }
        if !has_db {
            return Err("backup zip does not contain valid database file".to_string());
        }
        match super::health::deep_check_failure(&probe) {
            Some(msg) => Err(format!(
                "backup database failed integrity_check, refuse to restore: {msg}"
            )),
            None => Ok(()),
        }
    })();
    let _ = fs::remove_file(&probe);
    // 库是 WAL 模式时检查过程会顺手建出 sidecar，跟着一起清掉
    let _ = fs::remove_file(format!("{}-wal", probe.display()));
    let _ = fs::remove_file(format!("{}-shm", probe.display()));
    result
}

/// 解压备份 zip（写入前再校验一次条目安全；调用方负责失败回滚）。
/// 落点分两处：config.json 回它自己的配置目录，其余条目相对数据目录。
fn extract_backup_zip(src: &Path, data_dir: &Path, config_target: &Path) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| format!("open backup: {e}"))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("invalid zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry: {e}"))?;
        let name = entry.name().to_string();
        // 安全校验：禁止路径穿越（../），只允许相对路径下的文件名或 assets/xxx
        let rel = Path::new(&name);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("invalid zip entry (path traversal): {name}"));
        }
        // 只写入数据库、assets/ 下的内容与两个旁路文件，其余条目忽略（更安全）
        let is_db = name == DB_FILE;
        let in_assets = name.starts_with(&format!("{ASSETS_DIR}/")) || name == ASSETS_DIR;
        let is_config = name == CONFIG_FILE_NAME;
        let is_tombstone = name == TOMBSTONE_FILE;
        if !is_db && !in_assets && !is_config && !is_tombstone {
            continue;
        }
        let target = if is_config {
            config_target.to_path_buf()
        } else {
            data_dir.join(rel)
        };
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("mkdir {name}: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir parent {name}: {e}"))?;
            }
            let mut out = fs::File::create(&target).map_err(|e| format!("write {name}: {e}"))?;
            // 流式解压：单个附件可能很大，整份读进内存没有意义
            io::copy(&mut entry, &mut out).map_err(|e| format!("write {name}: {e}"))?;
        }
    }
    Ok(())
}

/// 回滚导入：清掉可能解压出的 db/assets，再把 stash 的 .bak 改回原名（含 -wal/-shm 侧车）
fn rollback_import_stash(data_dir: &Path, config_target: &Path, suffix: &str, scope: BackupScope) {
    let db = data_dir.join(DB_FILE);
    let assets_dir = data_dir.join(ASSETS_DIR);
    // 半解压出的新库必须清掉：Windows 下 rename 不能覆盖已存在文件，留着会让 .bak 还原失败
    let _ = fs::remove_file(&db);
    let db_bak = data_dir.join(format!("{DB_FILE}.bak-{suffix}"));
    if db_bak.is_file() {
        let _ = fs::rename(&db_bak, &db);
    }
    for ext in ["-wal", "-shm"] {
        let from = data_dir.join(format!("{DB_FILE}.bak-{suffix}{ext}"));
        let to = data_dir.join(format!("{DB_FILE}{ext}"));
        if from.is_file() {
            let _ = fs::rename(&from, &to);
        }
    }
    // 只装数据库的归档没有 stash 附件与设置：照 Full 清一遍就会抹掉用户现有的附件
    if scope != BackupScope::Full {
        return;
    }
    // 半解压可能把 assets 写成了文件（条目名撞车），两种形态都要清掉才能把 .bak 目录改回原名
    let _ = fs::remove_dir_all(&assets_dir);
    let _ = fs::remove_file(&assets_dir);
    let assets_bak = data_dir.join(format!("{ASSETS_DIR}.bak-{suffix}"));
    if assets_bak.is_dir() {
        let _ = fs::rename(&assets_bak, &assets_dir);
    }
    // 设置：stash 过就复制回去；导入前本来没有配置文件，就删掉刚解压出来的那份
    let cfg_bak = data_dir.join(format!("{CONFIG_FILE_NAME}.bak-{suffix}"));
    if cfg_bak.is_file() {
        let _ = fs::copy(&cfg_bak, config_target);
    } else {
        let _ = fs::remove_file(config_target);
    }
}

/// 把旧 db 的 -wal/-shm 改名到 .bak-{suffix} 同名后缀。
/// 存在的文件改名失败必须中止：新恢复的库若被旧 WAL 回放会直接损坏。
pub(super) fn move_db_sidecars_to_bak(db: &Path, suffix: &str) -> Result<(), String> {
    for ext in ["-wal", "-shm"] {
        let from = db.with_file_name(format!("{DB_FILE}{ext}"));
        if !from.is_file() {
            continue;
        }
        let to = db.with_file_name(format!("{DB_FILE}.bak-{suffix}{ext}"));
        fs::rename(&from, &to).map_err(|e| format!("move old db{ext} away failed: {e}"))?;
    }
    Ok(())
}

/// 把当前 db 改名到 .bak-{suffix}，-wal/-shm 一并移走（新库绝不能继承旧 WAL，否则被错误回放损坏）。
/// 先 best-effort `wal_checkpoint(TRUNCATE)`：让 .bak 主文件尽量自包含（用户常单独拷走 .bak 文件）。
/// 注意：SQLite 打开/关闭库文件时可能会自行清理残留的 wal/shm，因此侧车文件是"被移走或被清掉"皆可，
/// 不变量只有一个——stash 结束后原名 wal/shm 不复存在。
pub(crate) fn stash_current_db(db: &Path, suffix: &str) -> Result<(), String> {
    let wal = db.with_file_name(format!("{DB_FILE}-wal"));
    let shm = db.with_file_name(format!("{DB_FILE}-shm"));
    if !db.is_file() {
        // 无主库文件时的孤儿 wal/shm 直接清掉（无法回放，留着会污染新库）
        let _ = fs::remove_file(&wal);
        let _ = fs::remove_file(&shm);
        return Ok(());
    }
    if let Ok(conn) = rusqlite::Connection::open(db) {
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)", []);
    }
    let bak = db.with_file_name(format!("{DB_FILE}.bak-{suffix}"));
    fs::rename(db, &bak).map_err(|e| {
        format!("backup db failed (data dir may be in use; retry after closing the app): {e}")
    })?;
    // 与主库同生共死：移走失败必须中止，否则解压出的新库会撞上旧 WAL
    move_db_sidecars_to_bak(db, suffix)
}
