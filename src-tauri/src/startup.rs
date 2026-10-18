//! 进程生命周期：开机自启与崩溃后自动重启。
//!
//! 本项目只出 Windows 版，注册表 API 直接用，不写跨平台回退。
//! 两件共同的前提：都默认关、都要能被「设置 → 开机与崩溃」一眼看懂发生了什么。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

/// 当前用户的登录启动项（与系统「启动文件夹」等价，无需管理员权限）
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "TsFlowy";

/// 崩溃自动重启开关：走偏好镜像存进 config.json（跟备份走），值 "1" 为开
pub const CRASH_RESTART_PREF: &str = "tsflowy:crash-restart";
/// 已经自动重启过几轮，由上一个进程通过环境变量交给新进程
pub const RESTART_ROUND_ENV: &str = "TSFLOWY_CRASH_RESTART_ROUND";
/// 连续崩溃最多自动拉起两次：再往上多半是数据/环境坏了，循环重启只会把用户困住
const MAX_RESTARTS: u32 = 2;
/// 崩溃进程还压着 single-instance 锁时新实例立刻起来会被转交给将死的旧进程，先等这一会儿
pub const RESTART_SETTLE_MS: u64 = 1500;

/// `current_exe()` 在 Windows 上返回 `\\?\C:\...`（扩展长度路径）。
/// 这种串写进注册表、或拿去和注册表里记的普通路径比对都会对不上，先剥掉前缀。
pub fn plain_exe_path(exe: &Path) -> String {
    let raw = exe.display().to_string();
    match raw.strip_prefix(r"\\?\") {
        Some(stripped) => stripped.to_string(),
        None => raw,
    }
}

/// 注册表里的启动命令：安装路径常带空格（`C:\Program Files\...`），不整体加引号会被截断
pub fn run_command_for(exe: &Path) -> String {
    format!("\"{}\"", plain_exe_path(exe))
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("取当前可执行文件路径失败：{e}"))
}

fn open_run_key(access: u32) -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, access)
        .map_err(|e| format!("打开注册表 Run 项失败：{e}"))
}

/// 记录值与当前可执行文件一致才算已开启：装在别处、或被移动过留下的残留项按「没开」处理，
/// 用户再拨一次开关就会覆盖成正确路径，而不是显示一个永远达不成的「已开启」
pub fn autostart_enabled() -> Result<bool, String> {
    let want = run_command_for(&current_exe()?);
    match open_run_key(KEY_READ)?.get_value::<String, _>(RUN_VALUE) {
        Ok(stored) => Ok(stored == want),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("读取自启项失败：{e}")),
    }
}

pub fn set_autostart_enabled(on: bool) -> Result<(), String> {
    let key = open_run_key(KEY_SET_VALUE)?;
    if on {
        let cmd = run_command_for(&current_exe()?);
        key.set_value(RUN_VALUE, &cmd)
            .map_err(|e| format!("写入自启项失败：{e}"))
    } else {
        // 本来就没开过：删除报 NOT_FOUND，效果已达成，不算失败
        let Err(e) = key.delete_value(RUN_VALUE) else {
            return Ok(());
        };
        if e.kind() == std::io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(format!("删除自启项失败：{e}"))
        }
    }
}

#[derive(Serialize)]
pub struct AutostartState {
    pub enabled: bool,
    /// 开关背后真正写进注册表的命令，展示出来便于排查「装了两份」这类事
    pub command: String,
    /// 注册表都读不到时（受限环境）为 true：界面据此收起开关而不是显示一个假状态
    pub unavailable: bool,
}

/// 已第几轮自动重启（环境变量里存的十进制；认不出的值一律按 0）
pub fn restart_round(raw: Option<OsString>) -> u32 {
    raw.and_then(|v| v.into_string().ok())
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

pub fn should_restart(round: u32, enabled: bool) -> bool {
    enabled && round < MAX_RESTARTS
}

fn crash_restart_on(app: &AppHandle) -> bool {
    crate::commands::files::load_app_config(app)
        .prefs
        .get(CRASH_RESTART_PREF)
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// panic 钩子：`panic = "abort"` 不展开栈，但钩子在终止前照常执行，所以这里能记日志并按需拉起新实例。
/// 只兜得住 Rust panic（WebView2 内部的访问违例到不了这里），文案与说明都按这个口径写。
pub fn install_panic_hook(app: AppHandle) {
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "-".to_string());
        tracing::error!(
            location = %location,
            panic = %info,
            backtrace = %std::backtrace::Backtrace::force_capture(),
            "panic: process is aborting"
        );
        let round = restart_round(std::env::var_os(RESTART_ROUND_ENV));
        if !should_restart(round, crash_restart_on(&app)) {
            return;
        }
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(e) => {
                tracing::warn!(error = %e, "crash restart: current_exe failed");
                return;
            }
        };
        // 命令行原样带上（深链等参数不能丢），轮次 +1 交给新实例继续判上限
        let mut cmd = Command::new(&exe);
        for arg in restart_args(std::env::args_os()) {
            cmd.arg(arg);
        }
        match cmd
            .env(RESTART_ROUND_ENV, OsString::from((round + 1).to_string()))
            .spawn()
        {
            Ok(child) => tracing::warn!(
                pid = child.id(),
                round = round + 1,
                "crash restart: relaunched"
            ),
            Err(e) => tracing::warn!(error = %e, "crash restart: relaunch failed"),
        }
    }));
}

/// 崩溃重启出来的实例：先等旧进程退出完，再走 Tauri 启动（否则会被 single-instance 转交给将死的旧进程）
pub fn settle_before_restart() {
    if restart_round(std::env::var_os(RESTART_ROUND_ENV)) > 0 {
        std::thread::sleep(Duration::from_millis(RESTART_SETTLE_MS));
    }
}

/// 重启要交出去的命令行：`args_os().skip(1)` 丢掉自身路径，深链等启动参数原样保留
pub fn restart_args(raw: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    raw.into_iter().skip(1).collect()
}

#[tauri::command]
pub fn get_autostart() -> Result<AutostartState, String> {
    let exe = current_exe()?;
    let command = run_command_for(&exe);
    match autostart_enabled() {
        Ok(enabled) => Ok(AutostartState {
            enabled,
            command,
            unavailable: false,
        }),
        // 读不到注册表（组策略禁用 HKCU 等）不当错误抛给界面，给个「不可用」状态
        Err(e) => {
            tracing::warn!(error = %e, "autostart: read failed");
            Ok(AutostartState {
                enabled: false,
                command,
                unavailable: true,
            })
        }
    }
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    set_autostart_enabled(enabled)
}

/// 前端首帧用它决定要不要提示「上次异常退出，已自动重启」
#[tauri::command]
pub fn crash_restart_round() -> u32 {
    restart_round(std::env::var_os(RESTART_ROUND_ENV))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn strips_verbatim_prefix_before_showing_the_path() {
        assert_eq!(
            plain_exe_path(Path::new(r"\\?\D:\Code\TsFlowy.exe")),
            r"D:\Code\TsFlowy.exe"
        );
        assert_eq!(plain_exe_path(Path::new(r"D:\a.exe")), r"D:\a.exe");
    }

    #[test]
    fn quotes_the_whole_launch_command_for_paths_with_spaces() {
        assert_eq!(
            run_command_for(Path::new(r"C:\Program Files\TsFlowy\TsFlowy.exe")),
            r#""C:\Program Files\TsFlowy\TsFlowy.exe""#
        );
        assert_eq!(
            run_command_for(Path::new(r"\\?\D:\TsFlowy.exe")),
            r#""D:\TsFlowy.exe""#
        );
    }

    #[test]
    fn restart_round_tolerates_missing_and_bogus_env() {
        assert_eq!(restart_round(None), 0);
        assert_eq!(restart_round(Some(OsString::from(""))), 0);
        assert_eq!(restart_round(Some(OsString::from("x"))), 0);
        assert_eq!(restart_round(Some(OsString::from("-1"))), 0);
        assert_eq!(restart_round(Some(OsString::from("2"))), 2);
    }

    #[test]
    fn restarts_only_when_enabled_and_under_the_cap() {
        assert!(!should_restart(0, false));
        assert!(should_restart(0, true));
        assert!(should_restart(1, true));
        // 第三次不再拉：连续崩溃说明不是偶发
        assert!(!should_restart(2, true));
        assert!(!should_restart(9, true));
    }

    #[test]
    fn restart_settle_only_matters_for_relaunched_instances() {
        // 这里只断言常量本身：真正的等待在 run() 里，测试环境不该睡
        assert_eq!(RESTART_SETTLE_MS, 1500);
        assert_eq!(restart_round(Some(OsString::from("1"))), 1);
    }

    #[test]
    fn relaunch_keeps_argv_but_drops_the_program_path() {
        let args = restart_args([
            OsString::from(r"D:\Code\TsFlowy.exe"),
            OsString::from("--depth"),
            OsString::from("tsflowy://open/1"),
        ]);
        assert_eq!(
            args,
            vec![
                OsString::from("--depth"),
                OsString::from("tsflowy://open/1")
            ]
        );
        // 双击图标启动时 argv 只有 exe 一项，交出去的必须是空列表而不是重复自身
        assert!(restart_args([OsString::from(r"D:\Code\TsFlowy.exe")]).is_empty());
    }
}
