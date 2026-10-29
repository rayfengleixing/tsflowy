// 导出与打包：把一致性快照 + assets/ + 设置/墓碑清单写成 zip，以及迁移前留档的落盘与清理
// （从 backup.rs 原样搬入，逻辑未改）。fs / zip / 路径常量等共用导入见父模块。
use super::*;
// 写后校验复用恢复侧那一份（pub use 的 glob 不透出 pub(super) 项，故显式引入）
use super::import::validate_backup_zip;

/// 将数据库文件 + assets/ 目录 + 旁路文件（设置、附件墓碑清单）打包为 zip，
/// 写到 target_path（由前端文件对话框选）。
/// WAL 模式下直接复制主库文件会丢掉尚未 checkpoint 的事务（appflowy.db-wal），
/// 因此先 VACUUM INTO 出一致性快照（读快照包含全部已提交事务，输出自包含完整库）再打包。
/// 整库压缩 + 全量附件遍历可达数百 MB 的阻塞 IO，放 blocking 线程池执行。
#[tauri::command]
pub async fn export_backup(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_backup_blocking(app, target_path))
        .await
        .map_err(|e| format!("export task failed: {e}"))?
}

fn export_backup_blocking(app: tauri::AppHandle, target_path: String) -> Result<(), String> {
    ensure_dialog_authorized(&app, &target_path)?;
    let data_dir = app_data_dir(&app)?;
    let db = data_dir.join(DB_FILE);
    let assets = data_dir.join(ASSETS_DIR);

    if !db.is_file() {
        return Err(format!("database not found at {}", db.display()));
    }

    let target = Path::new(&target_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir failed: {e}"))?;
    }

    // VACUUM INTO 要求目标文件不存在；用纳秒时间戳避免并发导出互相踩踏
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snap = data_dir.join(format!("{DB_FILE}.export-{nanos}"));

    let outcome = make_db_snapshot(&db, &snap)
        .and_then(|()| write_backup_zip(target, &snap, &data_dir, &assets, BackupScope::Full));
    // 快照用完即删（成功/失败路径都覆盖）
    let _ = fs::remove_file(&snap);
    outcome
}

/// 用独立的只读连接对库做 VACUUM INTO 快照（并发写不受影响，快照内容为执行时刻的一致状态）
pub(crate) fn make_db_snapshot(db: &Path, snap: &Path) -> Result<(), String> {
    let conn =
        rusqlite::Connection::open(db).map_err(|e| format!("open db for snapshot failed: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("set busy timeout failed: {e}"))?;
    conn.execute("VACUUM INTO ?1", [snap.to_string_lossy().as_ref()])
        .map(|_| ())
        .map_err(|e| format!("create db snapshot failed: {e}"))
}

pub(crate) fn write_backup_zip(
    target: &Path,
    snap: &Path,
    data_dir: &Path,
    assets: &Path,
    scope: BackupScope,
) -> Result<(), String> {
    // 先写同目录临时文件、成功后 rename 覆盖：中途失败不会留下半截 zip
    //（半截 zip 会被自动备份清理逻辑当成"最新一份备份"保留下来，真正需要时才发现坏了）
    // rename 之前再用恢复链路同款校验把整档读回一遍：只保证 zip 写完不报错是不够的
    // ——正文被截断、坏道、Deflate 流末尾丢了中央目录还指得过去，这些都要真解压才现形。
    // 校验失败时临时文件删掉、旧档原封不动，于是那份坏档从来没进过备份目录。
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_file_name(format!(
        "{}.tmp-{}-{}",
        target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("backup.zip"),
        std::process::id(),
        unique
    ));
    let result = write_backup_zip_to(&tmp, snap, data_dir, assets, scope);
    match result.and_then(|()| {
        validate_backup_zip(&tmp)
            .map_err(|e| format!("backup archive failed post-write check: {e}"))
    }) {
        // 校验通过才装档：旧档此刻还原封不动，失败路径不会多占一份保留名额
        Ok(()) => {
            if target.exists() {
                let _ = fs::remove_file(target);
            }
            fs::rename(&tmp, target).map_err(|e| format!("install backup file failed: {e}"))
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 除数据库与 assets 外要一并入档的旁路文件：`(zip 条目名, 磁盘路径)`。
/// 磁盘上不存在的直接剔除（没同步过就没有墓碑，从没改过设置也可能没有 config）：
/// - `config.json`：放在数据目录之外的独立配置目录里。缺了它，换机恢复出来的库会配不上
///   原来的数据目录、自动备份与同步设置。**注意**：Key 正常情况下只存系统凭据库、不在配置文件里，
///   因此不会入档；只有凭据库不可用（或写入失败回退）时 config.json 才带明文 Key，此时归档跟着带一份。
/// - `deleted-assets.txt`：附件删除墓碑清单，丢了它同步会把对侧已删的附件「复活」。
fn sidecar_entries(data_dir: &Path) -> Vec<(String, PathBuf)> {
    [
        (CONFIG_FILE_NAME.to_string(), config_file_path()),
        (TOMBSTONE_FILE.to_string(), data_dir.join(TOMBSTONE_FILE)),
    ]
    .into_iter()
    .filter(|(_, path)| path.is_file())
    .collect()
}

fn write_backup_zip_to(
    target: &Path,
    snap: &Path,
    data_dir: &Path,
    assets: &Path,
    scope: BackupScope,
) -> Result<(), String> {
    let file = fs::File::create(target).map_err(|e| format!("create backup file failed: {e}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1. 写入数据库快照（zip 内路径即文件名，便于解包后直接对应）
    zip.start_file(DB_FILE, options)
        .map_err(|e| format!("zip start db failed: {e}"))?;
    let mut f = fs::File::open(snap).map_err(|e| format!("open db snapshot failed: {e}"))?;
    // 流式拷贝：库+附件可能上百 MB，整份读进内存会顶高峰值占用
    io::copy(&mut f, &mut zip).map_err(|e| format!("zip write db failed: {e}"))?;

    // 2. 范围清单：恢复时据此判断"这份归档本来就不含附件"，而不是"附件该被清空"
    zip.start_file(MANIFEST_ENTRY, options)
        .map_err(|e| format!("zip start manifest failed: {e}"))?;
    let manifest = format!("{{\"scope\":\"{}\"}}", scope.manifest_value());
    zip.write_all(manifest.as_bytes())
        .map_err(|e| format!("zip write manifest failed: {e}"))?;

    // 3. 遍历 assets/
    if scope == BackupScope::Full && assets.is_dir() {
        for entry in WalkDir::new(assets) {
            let entry = entry.map_err(|e| format!("walk assets failed: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let rel = path
                .strip_prefix(data_dir)
                .map_err(|e| format!("strip prefix failed: {e}"))?;
            let name = rel.to_string_lossy().replace('\\', "/");
            zip.start_file(name.clone(), options)
                .map_err(|e| format!("zip start {name} failed: {e}"))?;
            let mut f = fs::File::open(path).map_err(|e| format!("open asset failed: {e}"))?;
            io::copy(&mut f, &mut zip).map_err(|e| format!("zip write asset failed: {e}"))?;
        }
    }

    // 4. 旁路文件（设置 + 附件墓碑清单）：文件不存在时已在 sidecar_entries 里剔除
    if scope == BackupScope::Full {
        for (name, path) in sidecar_entries(data_dir) {
            zip.start_file(name.clone(), options)
                .map_err(|e| format!("zip start {name} failed: {e}"))?;
            let mut f = fs::File::open(path).map_err(|e| format!("open {name} failed: {e}"))?;
            io::copy(&mut f, &mut zip).map_err(|e| format!("zip write {name} failed: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(())
}

/// 迁移前自动留档保留的份数：更早的 DDL 留档既占盘也不会有人回看
const KEEP_PRE_MIGRATION: usize = 3;

/// 跑迁移之前先把当前库留一份可一键恢复的归档：
/// `backups/tsflowy-backup-premigration-<时间戳>-v<版本>.zip`。
/// 迁移是整库唯一的不可逆写操作（DROP/重建表 + 数据规整），一旦失败或事后才发现数据被规整弄坏，
/// 用户手边必须有原件。归档名沿用手动导出前缀，因此直接出现在设置页的备份列表里、走同一条恢复链路。
/// 只打数据库（DatabaseOnly）：DDL 不动附件与设置，整份复制既慢又白占磁盘，
/// 也避免把 config.json（凭据库不可用时含明文 Key）多复制几份。
pub(crate) fn capture_pre_migration(db: &Path, version: i64) -> Result<PathBuf, String> {
    let data_dir = db
        .parent()
        .ok_or_else(|| "database path has no parent directory".to_string())?;
    let dir = data_dir.join(BACKUP_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create backups dir failed: {e}"))?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snap = data_dir.join(format!("{DB_FILE}.pre-migration-{nanos}"));
    let target = dir.join(format!(
        "{PRE_MIGRATION_PREFIX}{}-v{version}.zip",
        backup_stamp()
    ));
    let assets = data_dir.join(ASSETS_DIR);
    let outcome = make_db_snapshot(db, &snap).and_then(|()| {
        write_backup_zip(&target, &snap, data_dir, &assets, BackupScope::DatabaseOnly)
    });
    let _ = fs::remove_file(&snap);
    outcome?;
    prune_pre_migration(&dir);
    Ok(target)
}

/// 只保留最新 KEEP_PRE_MIGRATION 份迁移留档。
/// 按文件名排序（时间戳定宽，字典序即时间序）而不是按 mtime：归档被复制/同步后 mtime 会变。
pub(super) fn prune_pre_migration(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(PRE_MIGRATION_PREFIX) || !name.ends_with(".zip") {
                return None;
            }
            entry.metadata().ok()?.is_file().then_some(name)
        })
        .collect();
    if names.len() <= KEEP_PRE_MIGRATION {
        return;
    }
    names.sort();
    for name in names.iter().take(names.len() - KEEP_PRE_MIGRATION) {
        let _ = fs::remove_file(dir.join(name));
    }
}
