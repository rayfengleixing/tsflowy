// config.json 的落盘：目录解析、损坏文件的救援式加载、读写（先写临时文件再 rename）。
// （从 config.rs 原样搬入，逻辑未改）。
use super::*;

/// 独立于 AppHandle 的 config 目录解析（给 lib.rs 在 Builder.plugin() 之前调用）。
/// 放在系统 config 目录下的"TsFlowyConfig"子目录，与默认数据目录物理独立，
/// 保证"把默认数据目录重命名为备份"时，config.json 不会被一并搬走。
pub fn app_config_dir_raw() -> PathBuf {
    fn home() -> PathBuf {
        std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
    let base = if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config"))
    };
    base.join(CONFIG_DIR_NAME)
}

pub fn config_file_path() -> PathBuf {
    app_config_dir_raw().join(CONFIG_FILE_NAME)
}

/// 读取并解析 config.json。文件存在但内容损坏时**不能**静默回落默认值——
/// 那会让用户以为自定义数据目录等设置"自己丢了"。先把坏文件挪成 config.json.broken-<毫秒>
/// （保留原件供人工找回，且避免下次启动重复告警），记 warn 后再落默认值。
fn parse_config_or_rescue(p: &std::path::Path) -> AppConfig {
    let Ok(s) = fs::read_to_string(p) else {
        return AppConfig::default();
    };
    match serde_json::from_str::<AppConfig>(&s) {
        Ok(cfg) => cfg,
        Err(e) => {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let bak = p.with_file_name(format!("{CONFIG_FILE_NAME}.broken-{ms}"));
            let moved = fs::rename(p, &bak).is_ok();
            tracing::warn!(
                "config.json 损坏（{e}），{}原文件已挪到 {} 供恢复",
                if moved { "" } else { "备份失败，" },
                bak.display()
            );
            AppConfig::default()
        }
    }
}

pub fn load_config_raw() -> AppConfig {
    parse_config_or_rescue(&config_file_path())
}

fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(CONFIG_DIR_NAME))
        .or_else(|_| Ok(app_config_dir_raw()))
}

pub(crate) fn load_app_config(app: &tauri::AppHandle) -> AppConfig {
    let p = app_config_dir(app)
        .map(|d| d.join(CONFIG_FILE_NAME))
        .unwrap_or_else(|_| config_file_path());
    parse_config_or_rescue(&p)
}

pub(crate) fn save_app_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("config json: {e}"))?;
    // 同目录临时文件 + rename 覆盖：磁盘上的 config.json 任何时刻要么是旧完整内容、要么是新完整内容，
    // 不会因写一半崩溃/断电留下半截 JSON（损坏会被 load_app_config 挪成 .broken 文件并告警，而不是静默吞掉）
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    fs::write(&tmp, s).map_err(|e| format!("write config: {e}"))?;
    fs::rename(&tmp, dir.join(CONFIG_FILE_NAME)).map_err(|e| format!("replace config: {e}"))
}
