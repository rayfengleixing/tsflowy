// config 的用例（从 config.rs 的 tests 模块原样搬入，断言未改）。
use super::*;

use super::*;

#[test]
fn retention_defaults_match_the_old_hardcoded_values() {
    let cfg = AppConfig::default();
    assert_eq!(cfg.snapshot.interval_minutes, 10);
    assert_eq!(cfg.snapshot.keep, 50);
    assert_eq!(cfg.snapshot.pre_restore_keep, 5);
    assert_eq!(cfg.trash.retention_days, 30);
}

/// 旧 config.json 没有 snapshot / trash 字段：整体按默认值回落，其余字段不受影响
#[test]
fn config_without_retention_fields_falls_back_to_defaults() {
    let legacy = r#"{
            "custom_data_dir": "D:/data",
            "auto_backup": { "enabled": false, "interval_hours": 6, "keep": 3 },
            "sync": { "dir": null }
        }"#;
    let cfg: AppConfig = serde_json::from_str(legacy).unwrap();
    assert_eq!(cfg.custom_data_dir.as_deref(), Some("D:/data"));
    assert_eq!(
        (
            cfg.auto_backup.enabled,
            cfg.auto_backup.interval_hours,
            cfg.auto_backup.keep
        ),
        (false, 6, 3)
    );
    assert_eq!(cfg.snapshot.interval_minutes, 10);
    assert_eq!(cfg.snapshot.keep, 50);
    assert_eq!(cfg.snapshot.pre_restore_keep, 5);
    assert_eq!(cfg.trash.retention_days, 30);
}

/// 字段残缺（如只写了 keep）时，缺的那几项同样走默认值而不是 0
#[test]
fn partially_present_retention_fields_use_defaults() {
    let cfg: AppConfig = serde_json::from_str(r#"{"snapshot":{"keep":120},"trash":{}}"#).unwrap();
    assert_eq!(cfg.snapshot.keep, 120);
    assert_eq!(cfg.snapshot.interval_minutes, 10);
    assert_eq!(cfg.snapshot.pre_restore_keep, 5);
    assert_eq!(cfg.trash.retention_days, 30);
}

#[test]
fn snapshot_config_clamps_to_safe_range() {
    let low = SnapshotConfig {
        interval_minutes: 0,
        keep: 0,
        pre_restore_keep: 0,
    }
    .normalized();
    assert_eq!(
        (low.interval_minutes, low.keep, low.pre_restore_keep),
        (
            SNAPSHOT_INTERVAL_MINUTES_MIN,
            SNAPSHOT_KEEP_MIN,
            PRE_RESTORE_KEEP_MIN
        )
    );

    let high = SnapshotConfig {
        interval_minutes: 999_999,
        keep: 999_999,
        pre_restore_keep: 999_999,
    }
    .normalized();
    assert_eq!(
        (high.interval_minutes, high.keep, high.pre_restore_keep),
        (
            SNAPSHOT_INTERVAL_MINUTES_MAX,
            SNAPSHOT_KEEP_MAX,
            PRE_RESTORE_KEEP_MAX
        )
    );
}

/// 偏好镜像是后加的字段：旧 config.json 没有它时必须读成空表而不是报错
#[test]
fn legacy_config_without_prefs_reads_as_empty_map() {
    let cfg: AppConfig = serde_json::from_str(r#"{"custom_data_dir":"D:/data"}"#).unwrap();
    assert!(cfg.prefs.is_empty());
    let round: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert!(round.prefs.is_empty());
}

#[test]
fn prefs_round_trip_keeps_every_key() {
    let mut cfg = AppConfig::default();
    cfg.prefs.insert(
        "tsflowy:auto-sync".to_string(),
        "{\"periodic\":true}".to_string(),
    );
    let parsed: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(
        parsed.prefs.get("tsflowy:auto-sync").map(String::as_str),
        Some("{\"periodic\":true}")
    );
}

#[test]
fn trash_config_clamps_to_safe_range() {
    assert_eq!(
        TrashConfig { retention_days: 0 }
            .normalized()
            .retention_days,
        TRASH_RETENTION_DAYS_MIN
    );
    assert_eq!(
        TrashConfig {
            retention_days: 400
        }
        .normalized()
        .retention_days,
        TRASH_RETENTION_DAYS_MAX
    );
    assert_eq!(
        TrashConfig { retention_days: 7 }
            .normalized()
            .retention_days,
        7
    );
}

/// 配置以分钟为单位，注入 db::snapshots 时换算成毫秒
#[test]
fn snapshot_policy_converts_minutes_and_clamps_first() {
    let policy = SnapshotConfig {
        interval_minutes: 30,
        keep: 20,
        pre_restore_keep: 2,
    }
    .policy();
    assert_eq!(policy.interval_ms, 30 * 60 * 1000);
    assert_eq!(policy.keep, 20);
    assert_eq!(policy.pre_restore_keep, 2);

    let clamped = SnapshotConfig {
        interval_minutes: 0,
        keep: 5_000,
        pre_restore_keep: 5_000,
    }
    .policy();
    assert_eq!(
        clamped.interval_ms,
        SNAPSHOT_INTERVAL_MINUTES_MIN as i64 * 60_000
    );
    assert_eq!(clamped.keep, SNAPSHOT_KEEP_MAX as i64);
    assert_eq!(clamped.pre_restore_keep, PRE_RESTORE_KEEP_MAX as i64);
}
