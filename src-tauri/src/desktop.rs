use std::str::FromStr;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::files::{load_app_config, save_app_config, CaptureShortcut};

pub const DEEP_LINK_SCHEME: &str = "tsflowy";
pub const TRAY_ID: &str = "tsflowy-tray";

/// 壳层（系统托盘）的文案表。
/// 网页端文案在 i18n 目录里，但托盘菜单是系统控件、前端渲染不到，只能在这里存一份；
/// 新增条目时记得同步 `src/lib/i18n/zh.ts` 里对应的界面说法。
#[derive(Clone, Copy)]
struct ShellLabels {
    tray_toggle: &'static str,
    tray_quit: &'static str,
}

const LABELS_ZH: ShellLabels = ShellLabels {
    tray_toggle: "显示/隐藏主窗口",
    tray_quit: "退出 TsFlowy",
};

const LABELS_EN: ShellLabels = ShellLabels {
    tray_toggle: "Show/Hide main window",
    tray_quit: "Quit TsFlowy",
};

/// 前端存的是 `zh-CN` / `en-US`（见 src/lib/i18n/languages.ts），这里只认前缀，
/// 其余（含未设置、异常值）一律按中文，与界面默认语言一致。
fn labels_for(lang: &str) -> ShellLabels {
    if lang.starts_with("en") {
        LABELS_EN
    } else {
        LABELS_ZH
    }
}

fn build_tray_menu(app: &AppHandle, labels: ShellLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItem::with_id(app, "tray:toggle", labels.tray_toggle, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray:quit", labels.tray_quit, true, None::<&str>)?;
    Menu::with_items(app, &[&toggle, &quit])
}

/// 按语言重建托盘菜单。托盘事件走的是 app 级 handler 且 id 不变，重建后无需重新注册。
/// 窗口不挂原生菜单栏（Tauri 只在 macOS 造默认菜单，Windows 上不 set_menu 就没有）：
/// 原文件/编辑/视图/窗口那套在前端都有等价入口 —— `Ctrl+N` 新建、`Ctrl+,` 设置、`Ctrl+K` 命令面板、
/// 撤销与剪贴板由编辑器和 WebView 自己接，最小化 / 关闭在标题栏，退出走 X 或托盘。
pub fn apply_labels(app: &AppHandle, lang: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(build_tray_menu(app, labels_for(lang))?))?;
    }
    Ok(())
}

/// 启动时的语言取偏好镜像里的 `tsflowy-lang`（config.json，进备份）；
/// 镜像最坏滞后 30 秒，所以前端首帧还会用 `set_lang` 命令校准一次。
fn startup_lang(app: &AppHandle) -> String {
    crate::commands::files::load_app_config(app)
        .prefs
        .get("tsflowy-lang")
        .cloned()
        .unwrap_or_default()
}

/// 前端切换语言时同步壳层文案（参数是 `LangCode` 原文，识别不了就退回中文）
#[tauri::command]
pub fn set_lang(app: AppHandle, lang: String) -> Result<(), String> {
    apply_labels(&app, &lang).map_err(|e| format!("refresh tray labels failed: {e}"))
}

/// 从第二个实例转发的 argv 里提取 tsflowy:// 深链 URL（Windows 协议触发时 exe 被再次启动，
/// URL 作为唯一命令行参数；single-instance 会把整串 argv 转交给已运行实例）。
pub fn deep_link_urls_from_argv(argv: &[String]) -> Vec<String> {
    let prefix = format!("{DEEP_LINK_SCHEME}://");
    argv.iter()
        .filter(|arg| arg.starts_with(&prefix))
        .cloned()
        .collect()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn reveal_window(win: &WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 托盘图标点击 / 托盘「显示/隐藏主窗」：可见且未最小化 → 隐藏，否则唤起聚焦
fn toggle_main_window(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let minimized = win.is_minimized().unwrap_or(false);
    if visible && !minimized {
        let _ = win.hide();
    } else {
        reveal_window(&win);
    }
}

/// 托盘「退出」：走 Window::close() 触发 CloseRequested，
/// 由前端 onCloseRequested 完成挂起写入冲刷后再 destroy，与点 X 关窗同一条路径。
/// 退出前先唤起窗口，避免冲刷失败后的确认对话框落在隐藏窗口里不可见。
fn quit_via_close(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        reveal_window(&win);
        let _ = win.close();
    }
}

/// 本进程当前占用的那条系统唤起快捷键（None = 没注册）。
/// 换绑要先摘掉旧的，而插件没有公开「列出已注册」的接口，只能自己记。
#[derive(Default)]
struct RegisteredShortcut(Mutex<Option<Shortcut>>);

fn on_capture_pressed(
    app: &AppHandle,
    _shortcut: &Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    // 按下与松开都会回调一次，只认按下
    if event.state == ShortcutState::Pressed {
        if let Some(win) = main_window(app) {
            reveal_window(&win);
        }
    }
}

/// 把配置里的 Combo 解析成插件用的 Shortcut。加速串语法由 global-hotkey 的表认，
/// 因此前端录制器交出的键名（`t`、`f5`、`space`、`arrowup`）不需要这里再维护一份码表。
fn parse_capture_shortcut(cfg: &CaptureShortcut) -> Result<Shortcut, String> {
    let accel = cfg.accelerator()?;
    Shortcut::from_str(&accel).map_err(|e| format!("快捷键 {accel} 无法解析：{e}"))
}

/// 按 cfg 换绑系统快捷键：先摘旧的再注册新的；新的注册失败（多半被别的软件占用）就把旧的装回去。
/// 返回 Err 时调用方不要写 config.json —— 界面该显示的是系统里真的生效的那条，不是用户刚点的那条。
fn rebind_capture_shortcut(app: &AppHandle, cfg: &CaptureShortcut) -> Result<(), String> {
    let holder = app.state::<RegisteredShortcut>();
    let previous = *holder.0.lock().unwrap();
    let gs = app.global_shortcut();
    if let Some(old) = previous {
        // 摘不掉也没什么可补救的：系统里那条已经不属于我们了，继续往下注册新的
        let _ = gs.unregister(old);
        *holder.0.lock().unwrap() = None;
    }
    if !cfg.enabled {
        return Ok(());
    }
    let shortcut = parse_capture_shortcut(cfg)?;
    match gs.on_shortcut(shortcut, on_capture_pressed) {
        Ok(()) => {
            *holder.0.lock().unwrap() = Some(shortcut);
            Ok(())
        }
        Err(e) => {
            // 一次失败的改绑不该把用户原本还能用的唤起键一起带走
            if let Some(old) = previous {
                if gs.on_shortcut(old, on_capture_pressed).is_ok() {
                    *holder.0.lock().unwrap() = Some(old);
                }
            }
            Err(format!(
                "快捷键 {} 注册失败（可能已被其它应用占用）：{e}",
                cfg.key.to_uppercase()
            ))
        }
    }
}

/// 读取当前生效的系统唤起快捷键（config.json 里的值）
#[tauri::command]
pub fn get_capture_shortcut(app: AppHandle) -> CaptureShortcut {
    load_app_config(&app).capture_shortcut
}

/// 改绑系统唤起快捷键。注册成功才落盘，失败时原样返回错误、配置不动。
#[tauri::command]
pub fn set_capture_shortcut(
    app: AppHandle,
    shortcut: CaptureShortcut,
) -> Result<CaptureShortcut, String> {
    rebind_capture_shortcut(&app, &shortcut)?;
    let mut cfg = load_app_config(&app);
    cfg.capture_shortcut = shortcut;
    save_app_config(&app, &cfg)?;
    Ok(cfg.capture_shortcut)
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    // ——— 系统托盘：文案按启动时记下的语言，之后由 set_lang 命令跟随切换 ———
    let lang = startup_lang(app);
    let tray_menu = build_tray_menu(app, labels_for(&lang))?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("TsFlowy")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });
    match app.default_window_icon() {
        Some(icon) => tray = tray.icon(icon.clone()),
        None => tracing::warn!("tray: no bundled window icon found, using platform default"),
    }
    let tray = tray.build(app)?;
    // TrayIcon 被 drop 会移除托盘图标，必须由状态持有
    app.manage(tray);

    // 托盘菜单事件在 Rust 侧处理（退出经由 CloseRequested 冲刷路径）
    let handler_app = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id.as_ref();
        match id {
            "tray:toggle" => toggle_main_window(&handler_app),
            "tray:quit" => quit_via_close(&handler_app),
            _ => {}
        }
    });

    // ——— 系统级唤起/聚焦主窗快捷键：绑定存 config.json，改绑走 set_capture_shortcut ———
    // 注册失败（被其它应用占用）只告警，不阻塞启动；设置页里换一条即可
    app.manage(RegisteredShortcut::default());
    let capture = load_app_config(app).capture_shortcut;
    if let Err(e) = rebind_capture_shortcut(app, &capture) {
        tracing::warn!(error = %e, "capture shortcut register failed");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn extracts_deep_link_urls_from_argv() {
        let argv = args(&[
            r"C:\Apps\TsFlowy.exe",
            "tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab",
        ]);
        let urls = deep_link_urls_from_argv(&argv);
        assert_eq!(
            urls,
            vec!["tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab".to_string()]
        );
    }

    #[test]
    fn ignores_plain_second_instance_argv() {
        let argv = args(&[r"C:\Apps\TsFlowy.exe", "--flag", "extra"]);
        assert!(deep_link_urls_from_argv(&argv).is_empty());
    }
    #[test]
    fn skips_other_schemes_and_keeps_multiple_urls() {
        let argv = args(&[
            "exe",
            "https://example.com",
            "tsflowy://page/a",
            "tsflowy://page/b?x=1",
        ]);
        assert_eq!(
            deep_link_urls_from_argv(&argv),
            vec!["tsflowy://page/a", "tsflowy://page/b?x=1"]
        );
    }

    #[test]
    fn shell_labels_follow_lang_prefix() {
        assert_eq!(labels_for("en-US").tray_quit, "Quit TsFlowy");
        assert_eq!(labels_for("en-GB").tray_toggle, "Show/Hide main window");
        assert_eq!(labels_for("zh-CN").tray_quit, "退出 TsFlowy");
        // 未设置、或认不出的语言退回中文（与界面默认语言一致）
        assert_eq!(labels_for("").tray_toggle, "显示/隐藏主窗口");
        assert_eq!(labels_for("fr-FR").tray_toggle, "显示/隐藏主窗口");
    }

    fn combo(ctrl: bool, shift: bool, alt: bool, key: &str) -> CaptureShortcut {
        CaptureShortcut {
            enabled: true,
            ctrl,
            shift,
            alt,
            key: key.to_string(),
        }
    }

    /// 默认值必须与这份改动之前硬编码的那条一致：老用户升级后不该发现自己的唤起键变了
    #[test]
    fn default_capture_shortcut_is_ctrl_alt_t() {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        let parsed = parse_capture_shortcut(&CaptureShortcut::default()).unwrap();
        assert_eq!(
            parsed,
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT)
        );
    }

    #[test]
    fn capture_shortcut_accepts_named_and_function_keys() {
        use tauri_plugin_global_shortcut::Code;
        let cases = [
            (combo(true, false, false, "f5"), Code::F5),
            (combo(true, false, true, "space"), Code::Space),
            (combo(true, true, false, "arrowup"), Code::ArrowUp),
            (combo(false, false, true, "1"), Code::Digit1),
        ];
        for (cfg, code) in cases {
            let parsed =
                parse_capture_shortcut(&cfg).unwrap_or_else(|_| panic!("应能解析 {}", cfg.key));
            assert_eq!(parsed, Shortcut::new(Some(cfg_mods(&cfg)), code));
        }
    }

    fn cfg_mods(cfg: &CaptureShortcut) -> tauri_plugin_global_shortcut::Modifiers {
        use tauri_plugin_global_shortcut::Modifiers;
        let mut m = Modifiers::empty();
        if cfg.ctrl {
            m |= Modifiers::CONTROL;
        }
        if cfg.alt {
            m |= Modifiers::ALT;
        }
        if cfg.shift {
            m |= Modifiers::SHIFT;
        }
        m
    }

    /// 守卫在前端录制器之外再走一遍：全局快捷键没有 Ctrl/Alt 会吃掉正常输入
    #[test]
    fn capture_shortcut_requires_a_strong_modifier() {
        assert!(parse_capture_shortcut(&combo(false, true, false, "a")).is_err());
        assert!(parse_capture_shortcut(&combo(false, false, false, "a")).is_err());
        assert!(parse_capture_shortcut(&combo(true, false, false, "")).is_err());
        assert!(parse_capture_shortcut(&combo(true, false, false, "  ")).is_err());
    }

    #[test]
    fn capture_shortcut_rejects_keys_without_a_code() {
        // 录制器偶尔会交出 "+"、"\"" 这类码表里没有的键名：报错，不能静默注册成别的键
        assert!(parse_capture_shortcut(&combo(true, false, false, "+")).is_err());
    }
}
