// backup 的用例（从 backup.rs 的 tests 模块原样搬入，断言未改）。
// 这几个私有函数拆到了子模块，pub use 的 glob 不透出 pub(super) 项，故显式引入。
use super::export::prune_pre_migration;
use super::import::{
    import_backup_into, move_db_sidecars_to_bak, prune_stale_backups, validate_backup_zip,
};
use super::*;

use super::*;
use std::io::Write;

#[test]
fn prune_stale_backups_keeps_newest_groups_only() {
    let base = std::env::temp_dir().join(format!("tsflowy-prune-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let dir = base.join("data");
    fs::create_dir_all(&dir).unwrap();

    // 4 次导入的残留：db + assets 各一组（后缀 = 秒级时间戳，越大越新）
    for stamp in ["100", "200", "300", "400"] {
        fs::write(dir.join(format!("{DB_FILE}.bak-{stamp}")), b"x").unwrap();
        fs::create_dir_all(dir.join(format!("{ASSETS_DIR}.bak-{stamp}"))).unwrap();
    }
    // 同组的侧车文件：跟组走，不单独计数
    fs::write(dir.join(format!("{DB_FILE}.bak-400-wal")), b"x").unwrap();
    // 不合规名字：不认识就不动
    fs::write(dir.join("notes.txt"), b"keep").unwrap();
    fs::write(dir.join("weird.bak-abc"), b"keep").unwrap();

    prune_stale_backups(&dir);

    for stamp in ["400", "300", "200"] {
        assert!(
            dir.join(format!("{DB_FILE}.bak-{stamp}")).is_file(),
            "保留 {stamp}"
        );
        assert!(
            dir.join(format!("{ASSETS_DIR}.bak-{stamp}")).is_dir(),
            "保留 {stamp} 的 assets"
        );
    }
    assert!(
        dir.join(format!("{DB_FILE}.bak-400-wal")).is_file(),
        "同组侧车跟着保留"
    );
    assert!(
        !dir.join(format!("{DB_FILE}.bak-100")).exists(),
        "最旧一组被清掉"
    );
    assert!(!dir.join(format!("{ASSETS_DIR}.bak-100")).exists());
    assert!(dir.join("notes.txt").is_file());
    assert!(dir.join("weird.bak-abc").is_file());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn stash_moves_db_sidecars_to_bak() {
    let base = std::env::temp_dir().join(format!("tsflowy-stash-{}-sidecars", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let dir = base.join("data");
    fs::create_dir_all(&dir).unwrap();
    let db = dir.join(DB_FILE);
    fs::write(&db, b"main").unwrap();
    fs::write(dir.join(format!("{DB_FILE}-wal")), b"wal-bytes").unwrap();
    fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm-bytes").unwrap();

    move_db_sidecars_to_bak(&db, "77").unwrap();

    assert_eq!(
        fs::read(dir.join(format!("{DB_FILE}.bak-77-wal"))).unwrap(),
        b"wal-bytes"
    );
    assert_eq!(
        fs::read(dir.join(format!("{DB_FILE}.bak-77-shm"))).unwrap(),
        b"shm-bytes"
    );
    assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
    assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn stash_current_db_leaves_no_stale_wal_next_to_new_db() {
    // 伪造非 SQLite 主库 + 残留 wal/shm。SQLite 打开/关闭时可能自行清掉侧车文件，
    // 也可能留给 move_db_sidecars_to_bak 改名——两者皆可；不变量是 stash 结束后
    // 原名 wal/shm 不复存在（否则解压出的新库会被旧 WAL 回放损坏）。
    let base = std::env::temp_dir().join(format!("tsflowy-stash-{}-e2e", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let dir = base.join("data");
    fs::create_dir_all(&dir).unwrap();
    let db = dir.join(DB_FILE);
    fs::write(&db, b"main").unwrap();
    fs::write(dir.join(format!("{DB_FILE}-wal")), b"wal-bytes").unwrap();
    fs::write(dir.join(format!("{DB_FILE}-shm")), b"shm-bytes").unwrap();

    stash_current_db(&db, "77").unwrap();

    assert_eq!(
        fs::read(dir.join(format!("{DB_FILE}.bak-77"))).unwrap(),
        b"main"
    );
    assert!(!db.exists());
    assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
    assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn stash_current_db_clears_orphan_wal_shm_when_db_missing() {
    let base = std::env::temp_dir().join(format!("tsflowy-stash-{}-orphan", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let dir = base.join("data");
    fs::create_dir_all(&dir).unwrap();
    let db = dir.join(DB_FILE);
    fs::write(dir.join(format!("{DB_FILE}-wal")), b"stale").unwrap();
    fs::write(dir.join(format!("{DB_FILE}-shm")), b"stale").unwrap();

    stash_current_db(&db, "88").unwrap();

    assert!(!dir.join(format!("{DB_FILE}-wal")).exists());
    assert!(!dir.join(format!("{DB_FILE}-shm")).exists());
    // 无主库时不应产生 bak 文件
    assert!(!dir.join(format!("{DB_FILE}.bak-88")).exists());
    let _ = fs::remove_dir_all(&base);
}

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default();
    for (name, bytes) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn import_backup_rejects_bad_source_without_touching_data() {
    let base = std::env::temp_dir().join(format!("tsflowy-import-{}-bad", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let data = base.join("data");
    fs::create_dir_all(data.join("assets")).unwrap();
    fs::write(data.join(DB_FILE), b"precious").unwrap();
    fs::write(data.join("assets/pic.png"), b"png").unwrap();
    let cfg = base.join("config").join(CONFIG_FILE_NAME);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    fs::write(&cfg, b"{\"keep\":true}").unwrap();

    // 1) 非 zip 文件（用户选错文件）
    let not_zip = base.join("not-a-backup.zip");
    fs::write(&not_zip, b"definitely not a zip").unwrap();
    let err = import_backup_into(&data, &not_zip, &cfg).unwrap_err();
    assert!(err.contains("invalid zip archive"), "{err}");

    // 2) zip 可打开但不含数据库文件
    let no_db = base.join("no-db.zip");
    write_zip(&no_db, &[("assets/pic.png", b"other")]);
    let err = import_backup_into(&data, &no_db, &cfg).unwrap_err();
    assert!(
        err.contains("does not contain valid database file"),
        "{err}"
    );

    // 3) 含路径穿越条目
    let traversal = base.join("traversal.zip");
    write_zip(&traversal, &[("../evil.txt", b"x"), (DB_FILE, b"newdb")]);
    let err = import_backup_into(&data, &traversal, &cfg).unwrap_err();
    assert!(err.contains("path traversal"), "{err}");

    // 关键不变量：三次失败后原数据与设置分毫未动，也没有 .bak 残留（校验先于 stash）
    assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), b"precious");
    assert_eq!(fs::read(data.join("assets/pic.png")).unwrap(), b"png");
    assert_eq!(fs::read(&cfg).unwrap(), b"{\"keep\":true}");
    let leftovers: Vec<String> = fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".bak-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "unexpected .bak leftovers: {leftovers:?}"
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn import_backup_replaces_data_and_keeps_previous_as_bak() {
    let base = std::env::temp_dir().join(format!("tsflowy-import-{}-ok", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let data = base.join("data");
    fs::create_dir_all(data.join("assets")).unwrap();
    fs::write(data.join(DB_FILE), b"old-db").unwrap();
    fs::write(data.join("assets/old.png"), b"old-asset").unwrap();

    let good = base.join("good.zip");
    let restored_db = make_db_bytes("restored");
    write_zip(
        &good,
        &[
            (DB_FILE, restored_db.as_slice()),
            ("assets/new.png", b"new-asset"),
        ],
    );

    let cfg = base.join("config").join(CONFIG_FILE_NAME);
    import_backup_into(&data, &good, &cfg).unwrap();

    assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), restored_db);
    assert_eq!(fs::read(data.join("assets/new.png")).unwrap(), b"new-asset");
    assert!(!data.join("assets/old.png").exists());
    // 归档里没有 config 条目时，配置目录不该被凭空写出文件
    assert!(!cfg.exists());
    let names: Vec<String> = fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        names
            .iter()
            .any(|n| n.starts_with(&format!("{DB_FILE}.bak-"))),
        "{names:?}"
    );
    assert!(
        names
            .iter()
            .any(|n| n.starts_with(&format!("{ASSETS_DIR}.bak-"))),
        "{names:?}"
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn restore_writes_config_and_tombstones_and_rolls_back_on_failure() {
    let base = std::env::temp_dir().join(format!("tsflowy-sidecar-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let data = base.join("data");
    fs::create_dir_all(data.join("assets")).unwrap();
    fs::write(data.join(DB_FILE), b"old-db").unwrap();
    fs::write(data.join(TOMBSTONE_FILE), b"assets/gone.png\n").unwrap();
    // 配置目录与数据目录分开（真实环境里在 %APPDATA%，数据目录常被挪到别的盘）
    let cfg = base.join("config").join(CONFIG_FILE_NAME);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    fs::write(&cfg, b"{\"from\":\"old\"}").unwrap();

    let good = base.join("with-config.zip");
    let restored_db = make_db_bytes("sidecar");
    write_zip(
        &good,
        &[
            (DB_FILE, restored_db.as_slice()),
            (CONFIG_FILE_NAME, b"{\"from\":\"new\"}"),
            (TOMBSTONE_FILE, b"assets/other.png\n"),
            ("stray.txt", b"ignored"),
        ],
    );
    import_backup_into(&data, &good, &cfg).unwrap();

    // 三条链路各自落到正确位置；无关条目仍然忽略
    assert_eq!(fs::read(&cfg).unwrap(), b"{\"from\":\"new\"}");
    assert_eq!(
        fs::read(data.join(TOMBSTONE_FILE)).unwrap(),
        b"assets/other.png\n"
    );
    assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), restored_db);
    assert!(!data.join("stray.txt").exists());
    // 旧配置以同组 *.bak-<后缀> 存在数据目录：可回滚，也会被 prune_stale_backups 一起清理
    let cfg_bak: Vec<String> = fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(&format!("{CONFIG_FILE_NAME}.bak-")))
        .collect();
    assert_eq!(cfg_bak.len(), 1, "{cfg_bak:?}");

    // 解压中途失败（`assets` 条目是文件，后续 assets/a.png 无处可写）→ 整体回滚，
    // 配置也要退回本次导入开始前的内容
    let broken = base.join("broken.zip");
    write_zip(
        &broken,
        &[
            // 库是合法的（否则先被深检挡下，测不到解压中途失败的回滚），坏在 assets 条目
            (DB_FILE, make_db_bytes("rollback").as_slice()),
            (CONFIG_FILE_NAME, b"{\"from\":\"bogus\"}"),
            ("assets", b"not-a-dir"),
            ("assets/a.png", b"x"),
        ],
    );
    let err = import_backup_into(&data, &broken, &cfg).unwrap_err();
    assert!(err.contains("assets/a.png"), "{err}");
    assert_eq!(fs::read(&cfg).unwrap(), b"{\"from\":\"new\"}");
    assert_eq!(fs::read(data.join(DB_FILE)).unwrap(), restored_db);
    // 解压时被写成文件的残留 assets 条目要清掉：留在原地下次备份/同步会当目录遍历失败
    // 回滚不能把 assets 留在"文件"形态（下次备份/同步按目录遍历会失败）。
    // 目录形态是合法的：上一轮导入 stash 的 assets.bak 后缀相同（秒级时间戳），回滚把它改回来了
    assert!(!data.join("assets").is_file(), "半解压残留已清除");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn restore_creates_config_on_machine_that_had_none() {
    let base = std::env::temp_dir().join(format!("tsflowy-cfg-none-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let data = base.join("data");
    fs::create_dir_all(&data).unwrap();
    // 配置目录存在但还没有配置文件（换机恢复的常见形态）
    let cfg = base.join("config").join(CONFIG_FILE_NAME);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();

    let good = base.join("fresh.zip");
    write_zip(
        &good,
        &[
            (DB_FILE, make_db_bytes("fresh").as_slice()),
            (CONFIG_FILE_NAME, b"{\"a\":1}"),
        ],
    );
    import_backup_into(&data, &good, &cfg).unwrap();

    assert_eq!(fs::read(&cfg).unwrap(), b"{\"a\":1}");
    let cfg_baks: Vec<String> = fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(&format!("{CONFIG_FILE_NAME}.bak-")))
        .collect();
    assert!(
        cfg_baks.is_empty(),
        "本机原本没有配置，就不该留下配置的 .bak：{cfg_baks:?}"
    );
    let _ = fs::remove_dir_all(&base);
}

/// 造一个真实的 SQLite 库文件（capture_pre_migration 走 VACUUM INTO，需要合法库）
fn make_db_file(path: &Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE t(x TEXT);
             INSERT INTO t VALUES ('keep-me');",
    )
    .unwrap();
}

/// 造一个真实 SQLite 库的字节内容：恢复前的深检只放行真库，测试里的占位文本会被拒
fn make_db_bytes(tag: &str) -> Vec<u8> {
    let path = std::env::temp_dir().join(format!("tsflowy-dbbytes-{}-{tag}", std::process::id()));
    let _ = fs::remove_file(&path);
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE t(x TEXT);").unwrap();
        conn.execute("INSERT INTO t VALUES (?1)", [tag]).unwrap();
    }
    let bytes = fs::read(&path).unwrap();
    let _ = fs::remove_file(&path);
    bytes
}

fn zip_entry_names(path: &Path) -> Vec<String> {
    let file = fs::File::open(path).unwrap();
    let mut archive = ZipArchive::new(BufReader::new(file)).unwrap();
    (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect()
}

#[test]
fn pre_migration_snapshot_is_database_only_and_restorable() {
    let base = std::env::temp_dir().join(format!("tsflowy-premig-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let data = base.join("data");
    fs::create_dir_all(data.join("assets")).unwrap();
    let db = data.join(DB_FILE);
    make_db_file(&db);
    fs::write(data.join("assets/pic.png"), b"png").unwrap();
    let cfg = base.join("config").join(CONFIG_FILE_NAME);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    fs::write(&cfg, b"{\"secret\":\"token\"}").unwrap();

    let archive = capture_pre_migration(&db, 18).unwrap();
    assert!(archive.is_file());
    assert!(archive
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(PRE_MIGRATION_PREFIX));
    // 只装数据库 + 范围清单：附件与设置不进（否则明文密钥会被复制多份、留档体积等于整库）
    assert_eq!(
        zip_entry_names(&archive),
        vec![DB_FILE.to_string(), MANIFEST_ENTRY.to_string()]
    );
    validate_backup_zip(&archive).unwrap();

    // 快照是执行时刻的一致状态：原库里的数据在里面
    let unpacked = base.join("unpacked");
    fs::create_dir_all(&unpacked).unwrap();
    let snap = unpacked.join(DB_FILE);
    {
        let file = fs::File::open(&archive).unwrap();
        let mut z = ZipArchive::new(BufReader::new(file)).unwrap();
        let mut e = z.by_name(DB_FILE).unwrap();
        let mut out = fs::File::create(&snap).unwrap();
        io::copy(&mut e, &mut out).unwrap();
    }
    let conn = rusqlite::Connection::open(&snap).unwrap();
    let got: String = conn.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(got, "keep-me");

    // 留档归档走同一条恢复链路（迁移出事后的真正退路）：范围清单让它只换库，
    // 现有附件与设置原地不动 —— 否则"恢复迁移前"会变成"附件全没了"
    import_backup_into(&data, &archive, &cfg).unwrap();
    assert_eq!(fs::read(data.join("assets/pic.png")).unwrap(), b"png");
    assert_eq!(fs::read(&cfg).unwrap(), b"{\"secret\":\"token\"}");
    let stashed: Vec<String> = fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(&format!("{ASSETS_DIR}.bak-")))
        .collect();
    assert!(stashed.is_empty(), "不该把附件挪走：{stashed:?}");
    let _ = fs::remove_dir_all(&base);
}

/// 造一份只含 data.db 与范围清单的归档；库内容由调用方给
fn archive_with_db_body(base: &Path, body: &[u8]) -> PathBuf {
    let target = base.join("probe.zip");
    let file = fs::File::create(&target).unwrap();
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(DB_FILE, options).unwrap();
    zip.write_all(body).unwrap();
    zip.start_file(MANIFEST_ENTRY, options).unwrap();
    zip.write_all(br#"{"scope":"database_only"}"#).unwrap();
    zip.finish().unwrap();
    target
}

/// 校验过程解出来的探针文件不该留在归档旁边
fn leftover_probes(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("integrity-"))
        .collect()
}

#[test]
fn validate_rejects_archive_whose_database_is_not_a_database() {
    let base = std::env::temp_dir().join(format!("tsflowy-validate-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    // 条目名有 data.db、中央目录也打得开——旧校验（只看条目名）会放行这份档，
    // 等现有数据被它覆盖完才发现是垃圾
    let archive = archive_with_db_body(&base, b"this is not a sqlite database at all");
    let err = validate_backup_zip(&archive).unwrap_err();
    assert!(err.contains("integrity_check"), "{err}");
    assert!(leftover_probes(&base).is_empty());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn validate_accepts_real_archive_but_rejects_tampered_body() {
    let base = std::env::temp_dir().join(format!("tsflowy-validate-ok-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let db = base.join(DB_FILE);
    make_db_file(&db);
    // 只读连接拿不到 WAL sidecar，这里用刚写完的库文件本体
    let body = fs::read(&db).unwrap();
    let archive = archive_with_db_body(&base, &body);
    validate_backup_zip(&archive).unwrap();
    assert!(leftover_probes(&base).is_empty());

    // 库被截掉后半段：zip 本身完好、CRC 也对，但里面的库文件少页——
    // 只有真把 data.db 解开跑一遍检查才能发现
    let mut short = body.clone();
    short.truncate(short.len() * 3 / 4);
    let truncated = archive_with_db_body(&base, &short);
    assert!(validate_backup_zip(&truncated).is_err());

    // 归档中部一个字节翻掉（bit rot）：deflate 流要么读错要么 CRC 不匹配
    let mut raw = fs::read(&archive).unwrap();
    let at = raw.len() / 2;
    raw[at] ^= 0xff;
    let tampered = base.join("tampered.zip");
    fs::write(&tampered, &raw).unwrap();
    assert!(validate_backup_zip(&tampered).is_err());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn prune_pre_migration_keeps_newest_three_and_ignores_other_archives() {
    let base = std::env::temp_dir().join(format!("tsflowy-premig-prune-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    for stamp in ["20260101-000001", "20260102-000002", "20260103-000003"] {
        fs::write(
            base.join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v1.zip")),
            b"x",
        )
        .unwrap();
    }
    fs::write(
        base.join(format!("{PRE_MIGRATION_PREFIX}20260104-000004-v2.zip")),
        b"x",
    )
    .unwrap();
    fs::write(
        base.join(format!("{PRE_MIGRATION_PREFIX}20260105-000005-v3.zip")),
        b"x",
    )
    .unwrap();
    // 用户手动导出与自动备份的归档不在这次清理的管辖范围
    fs::write(base.join("tsflowy-backup-20260101-0000.zip"), b"keep").unwrap();
    fs::write(base.join("auto-20260101-000000.zip"), b"keep").unwrap();

    prune_pre_migration(&base);

    for stamp in ["20260103-000003", "20260104-000004", "20260105-000005"] {
        assert!(
            base.join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v1.zip"))
                .is_file()
                || base
                    .join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v2.zip"))
                    .is_file()
                || base
                    .join(format!("{PRE_MIGRATION_PREFIX}{stamp}-v3.zip"))
                    .is_file(),
            "保留 {stamp}"
        );
    }
    assert!(
        !base
            .join(format!("{PRE_MIGRATION_PREFIX}20260101-000001-v1.zip"))
            .exists(),
        "最旧两份被清掉"
    );
    assert!(!base
        .join(format!("{PRE_MIGRATION_PREFIX}20260102-000002-v1.zip"))
        .exists());
    assert!(base.join("tsflowy-backup-20260101-0000.zip").is_file());
    assert!(base.join("auto-20260101-000000.zip").is_file());
    let _ = fs::remove_dir_all(&base);
}
