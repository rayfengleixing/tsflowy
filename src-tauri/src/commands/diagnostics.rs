// 诊断包与前端日志落盘。
// 排障时最需要的那几样东西（日志、配置、库概况）原本只活在内存或控制台里，
// 而 WebView2 的控制台普通用户打不开——所以这里统一落盘，并给出「一键导出诊断包」。
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::files;
use super::files::ensure_dialog_authorized;
use super::files::health::integrity_report;
use super::sync::db_summary;
use crate::db::{Db, SharedDb};
use crate::logging;

/// 单份日志收进诊断包时保留的尾部字节数：整包不该被日志撑爆
const LOG_TAIL_BYTES: usize = 2 * 1024 * 1024;
/// 一次 IPC 最多收这么多行前端日志（前端本身已做批量，这里是兜底）
const CLIENT_LOG_MAX_LINES: usize = 200;
/// 单行长度上限：异常堆栈拼进一行时能把文件撑大
const CLIENT_LOG_MAX_CHARS: usize = 2000;

/// 前端 logger 送过来的一行
#[derive(Debug, Clone, Deserialize)]
pub struct ClientLogLine {
    pub level: String,
    pub message: String,
}

/// 批量写入本机日志文件（与 Rust tracing 同一份，按天切）。
/// 只落盘、不返回内容，前端无需等待结果，因此设为同步命令即可。
#[tauri::command]
pub fn write_client_logs(lines: Vec<ClientLogLine>) {
    for line in lines.into_iter().take(CLIENT_LOG_MAX_LINES) {
        let message: String = line.message.chars().take(CLIENT_LOG_MAX_CHARS).collect();
        logging::append_client(&line.level, &message);
    }
}

/// 诊断包里的一个条目：zip 内路径 + 内容
struct Part {
    name: String,
    bytes: Vec<u8>,
}

/// 密钥类字段名判定：config.json 正常情况下不含密钥（都在 Windows 凭据库），
/// 但凭据库不可用时会回退存进 config.json，而诊断包是准备发给别人的，必须先抹掉。
fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("api_key")
        || k.contains("apikey")
        || k == "key"
        || k.contains("token")
        || k.contains("secret")
        || k.contains("password")
}

/// 递归抹掉密钥类字段的值（保留键名，便于看出这项配了没配）
fn redact_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_secret_key(k) {
                    *v = if v.is_null() {
                        Value::String("<无>".to_string())
                    } else {
                        Value::String("<已脱敏>".to_string())
                    };
                    continue;
                }
                redact_secrets(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_secrets),
        _ => {}
    }
}

/// 只保留尾部若干字节，并从最近的换行处起头（半行比整行更难读）
fn tail_bytes(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() <= LOG_TAIL_BYTES {
        return bytes;
    }
    let start = bytes.len() - LOG_TAIL_BYTES;
    // 从最近的换行之后起头（半行比整行更难读）；找不到完整行边界就原样保留，
    // 宁可多带半行也不要把尾部内容整段丢掉
    let cut = match bytes[start..].iter().position(|b| *b == b'\n') {
        Some(off) if start + off + 1 < bytes.len() => start + off + 1,
        _ => start,
    };
    let mut tail = bytes.split_off(cut);
    let mut out = Vec::with_capacity(tail.len() + 32);
    out.extend_from_slice("[logging] 前文超长，此处起为该文件尾部\n".as_bytes());
    out.append(&mut tail);
    out
}

/// 把条目写成 zip：先落同目录临时文件再改名，避免半截压缩包
fn write_zip(target: &Path, parts: &[Part]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create target dir failed: {e}"))?;
    }
    let tmp = target.with_extension("zip.part");
    let file = File::create(&tmp).map_err(|e| format!("create diagnostics file failed: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    for part in parts {
        zip.start_file(part.name.replace('\\', "/"), options)
            .map_err(|e| format!("zip start {} failed: {e}", part.name))?;
        zip.write_all(&part.bytes)
            .map_err(|e| format!("zip write {} failed: {e}", part.name))?;
    }
    zip.finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename diagnostics failed: {e}")
    })
}

/// 收 logs/ 下现有日志（文件名保持原样，放进 zip 的 logs/ 目录）
fn collect_logs(dir: &Path) -> Vec<Part> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .map(|n| n.to_string_lossy().ends_with(".log"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().into_owned();
            let bytes = fs::read(&p).ok()?;
            Some(Part {
                name: format!("logs/{name}"),
                bytes: tail_bytes(bytes),
            })
        })
        .collect()
}

/// 拼装诊断包内容。任何一块读失败都不该让整个包失败，只降级成一行说明。
fn build_parts(app: &tauri::AppHandle, db: &SharedDb) -> Result<Vec<Part>, String> {
    let data_dir = files::real_data_dir(app)?;
    let db_path = db.db_path();
    let cfg = files::load_app_config(app);

    let mut summary = String::new();
    summary.push_str(&format!(
        "TsFlowy 诊断包\n生成时间: {}\n",
        files::format_local_time(SystemTime::now())
    ));
    summary.push_str(&format!("应用版本: {}\n", env!("CARGO_PKG_VERSION")));
    summary.push_str(&format!(
        "系统: {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    summary.push_str(&format!("数据目录: {}\n", data_dir.display()));
    summary.push_str(&format!(
        "数据库: {}（{} 字节）\n",
        db_path.display(),
        fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0)
    ));
    if let Some(dir) = logging::log_dir() {
        summary.push_str(&format!("日志目录: {}\n", dir.display()));
    }
    match files::backup_dir(app) {
        Ok(dir) => summary.push_str(&format!(
            "自动备份: {}（每 {} 小时，留 {} 份）目录 {}\n",
            if cfg.auto_backup.enabled {
                "开启"
            } else {
                "关闭"
            },
            cfg.auto_backup.interval_hours,
            cfg.auto_backup.keep,
            dir.display()
        )),
        Err(e) => summary.push_str(&format!("自动备份目录读取失败: {e}\n")),
    }
    summary.push_str(&format!(
        "文件夹同步: {}\n",
        match cfg.sync.dir.as_ref().filter(|d| !d.trim().is_empty()) {
            Some(dir) => format!("开启，目录 {dir}（内容为明文，见 README 已知限制）"),
            None => "未开启".to_string(),
        }
    ));
    summary.push_str(&format!(
        "文档快照: 每页间隔 {} 分钟、留 {} 份\n",
        cfg.snapshot.interval_minutes, cfg.snapshot.keep
    ));
    summary.push_str(&format!("回收站保留: {} 天\n", cfg.trash.retention_days));
    summary.push_str(&match cfg.ai.as_ref() {
        Some(ai) => format!(
            "AI 助手: {}（服务商 {}，模型 {}，档位 {} 套）\n",
            if ai.enabled { "开启" } else { "关闭" },
            ai.provider,
            ai.model,
            ai.profiles.len()
        ),
        None => "AI 助手: 未配置\n".to_string(),
    });
    // 偏好镜像能看出重装后自动同步等开关是否随备份回来了
    summary.push_str(&format!("已镜像偏好: {} 项\n", cfg.prefs.len()));

    let mut parts = vec![Part {
        name: "summary.txt".to_string(),
        bytes: summary.into_bytes(),
    }];

    // 结构快检：quick_check 不等价于整库深扫，但报障时这一步值得占几秒
    let report = integrity_report(&db_path, false);
    parts.push(Part {
        name: "integrity.json".to_string(),
        bytes: serde_json::to_vec_pretty(&report).unwrap_or_default(),
    });
    let counts = db_summary(&db_path);
    parts.push(Part {
        name: "content.json".to_string(),
        bytes: serde_json::to_vec_pretty(&counts).unwrap_or_default(),
    });

    // 配置：脱敏后收录。读不出就写一行原因，诊断包宁可少一块也不能失败
    let config_raw = fs::read(files::config_file_path()).unwrap_or_default();
    let config_text = match serde_json::from_slice::<Value>(&config_raw) {
        Ok(mut v) => {
            redact_secrets(&mut v);
            serde_json::to_vec_pretty(&v).unwrap_or_default()
        }
        Err(e) => format!("config.json 解析失败：{e}\n").into_bytes(),
    };
    parts.push(Part {
        name: "config.redacted.json".to_string(),
        bytes: config_text,
    });

    if let Some(dir) = logging::log_dir() {
        parts.extend(collect_logs(&dir));
    }
    Ok(parts)
}

/// 一键导出诊断包（设置页「数据库健康」区块）：zip 含日志、脱敏配置、结构快检与内容统计。
/// 打包是磁盘 IO，放 blocking 线程，别占 tokio worker。
#[tauri::command]
pub async fn export_diagnostics(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    target_path: String,
) -> Result<(), String> {
    let db = db.shared();
    tauri::async_runtime::spawn_blocking(move || {
        // 与 export_backup 同一口径：目标路径必须由保存对话框授权过，避免写到用户没选的地方
        ensure_dialog_authorized(&app, &target_path)?;
        let parts = build_parts(&app, &db)?;
        write_zip(Path::new(&target_path), &parts)
    })
    .await
    .map_err(|e| format!("diagnostics task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    // 生产代码只写 zip，读回来核对是测试的事
    use std::io::Read;
    use zip::ZipArchive;

    #[test]
    fn secret_keys_are_redacted_but_other_fields_survive() {
        let mut v: Value = serde_json::from_str(
            r#"{"ai":{"api_key":"sk-real","provider":"deepseek","profiles":[{"id":"p1","api_key":"sk-2","model":"x"}]},"note":"留底","password":"pw","sync":{"dir":"D:\\\\Sync"}}"#,
        )
        .unwrap();
        redact_secrets(&mut v);
        assert_eq!(v["ai"]["api_key"], Value::String("<已脱敏>".to_string()));
        assert_eq!(
            v["ai"]["profiles"][0]["api_key"],
            Value::String("<已脱敏>".to_string())
        );
        assert_eq!(v["password"], Value::String("<已脱敏>".to_string()));
        assert_eq!(v["ai"]["provider"], "deepseek");
        assert_eq!(v["note"], "留底");
        // 同步目录不是密钥，路径要留着（排障正需要）
        assert!(v["sync"]["dir"].as_str().unwrap().contains("Sync"));
    }

    #[test]
    fn null_secret_reads_as_absent_not_masked() {
        let mut v: Value = serde_json::from_str(r#"{"token":null}"#).unwrap();
        redact_secrets(&mut v);
        assert_eq!(v["token"], Value::String("<无>".to_string()));
    }

    #[test]
    fn tail_keeps_whole_lines_only() {
        // 每行 64 字节，凑到超过上限：截断点必然落在某行中间
        let line = format!("{}\n", "x".repeat(63));
        let mut bytes = Vec::new();
        while bytes.len() <= LOG_TAIL_BYTES {
            bytes.extend_from_slice(line.as_bytes());
        }
        bytes.extend_from_slice(b"tail marker\n");
        let total = bytes.len();
        let out = tail_bytes(bytes);
        let text = String::from_utf8_lossy(&out).into_owned();
        assert!(text.starts_with("[logging] 前文超长"), "{text}");
        assert!(text.ends_with("tail marker\n"), "{text}");
        let body: Vec<&str> = text.lines().skip(1).collect();
        let full = &body[..body.len() - 1];
        assert!(
            full.iter().all(|l| l.len() == 63),
            "存在被截半的行: {:?}",
            full.first()
        );
        assert!(out.len() < total);
        // 未超限的内容原样返回
        let small = b"keep me\n".to_vec();
        assert_eq!(tail_bytes(small.clone()), small);
    }

    #[test]
    fn zip_roundtrip_keeps_entries_and_names() {
        let base = std::env::temp_dir().join(format!(
            "tsflowy-dx-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("diag.zip");
        let parts = vec![
            Part {
                name: "summary.txt".into(),
                bytes: b"hi\n".to_vec(),
            },
            Part {
                name: "logs\\tsflowy-20261018.log".into(),
                bytes: b"log line\n".to_vec(),
            },
        ];
        write_zip(&target, &parts).unwrap();
        let mut zip = ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            names.contains(&"logs/tsflowy-20261018.log".to_string()),
            "{names:?}"
        );
        let mut text = String::new();
        zip.by_name("summary.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "hi\n");
        // 临时文件不该留下来
        assert!(!base.join("diag.zip.part").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn collect_logs_reads_only_log_files_from_the_dir() {
        let base = std::env::temp_dir().join(format!(
            "tsflowy-dx-logs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("tsflowy-20261017.log"), b"yesterday\n").unwrap();
        fs::write(base.join("tsflowy-20261018.log"), b"today\n").unwrap();
        fs::write(base.join("notes.txt"), b"ignore me\n").unwrap();
        let parts = collect_logs(&base);
        let names: Vec<&str> = parts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["logs/tsflowy-20261017.log", "logs/tsflowy-20261018.log"]
        );
        assert!(String::from_utf8_lossy(&parts[1].bytes).starts_with("today"));
        let _ = fs::remove_dir_all(&base);
    }
}
