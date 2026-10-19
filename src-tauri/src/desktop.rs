use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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

    // ——— 全局快捷键 Ctrl+Alt+T：唤起/聚焦主窗（快捷捕捉）———
    // 注册失败（被其它应用占用）只告警，不阻塞启动
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(win) = main_window(_app) {
                    reveal_window(&win);
                }
            }
        })
    {
        tracing::warn!(error = %e, "global shortcut Ctrl+Alt+T register failed (maybe taken by another app)");
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
}
