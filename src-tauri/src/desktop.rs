use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const DEEP_LINK_SCHEME: &str = "tsflowy";

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

/// 托盘「退出」与菜单「退出」：走 Window::close() 触发 CloseRequested，
/// 由前端 onCloseRequested 完成挂起写入冲刷后再 destroy，与点 X 关窗同一条路径。
/// 从托盘退出时先唤起窗口，避免冲刷失败后的确认对话框落在隐藏窗口里不可见。
fn quit_via_close(app: &AppHandle, reveal_first: bool) {
    if let Some(win) = main_window(app) {
        if reveal_first {
            reveal_window(&win);
        }
        let _ = win.close();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    // ——— 原生菜单栏（Windows；标签取中文字面量：前端 i18n 语言存 localStorage，Rust 侧拿不到） ———
    let new_page = MenuItem::with_id(app, "menu:new-page", "新建页面", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "menu:settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "menu:quit", "退出", true, None::<&str>)?;
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &new_page,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let palette = MenuItem::with_id(
        app,
        "menu:palette",
        "命令面板 / 全局搜索",
        true,
        None::<&str>,
    )?;
    let view = Submenu::with_items(app, "视图", true, &[&palette])?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&file, &edit, &view, &window_menu])?;
    app.set_menu(menu)?;

    // ——— 系统托盘 ———
    let tray_toggle = MenuItem::with_id(app, "tray:toggle", "显示/隐藏主窗口", true, None::<&str>)?;
    let tray_quit = MenuItem::with_id(app, "tray:quit", "退出 TsFlowy", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&tray_toggle, &tray_quit])?;
    let mut tray = TrayIconBuilder::with_id("tsflowy-tray")
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

    // 菜单事件统一走全局 handler：tray:* 在 Rust 侧处理（退出经由 CloseRequested 冲刷路径），
    // menu:* 转 emit 给前端调用现成动作
    let handler_app = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id.as_ref();
        match id {
            "menu:new-page" | "menu:settings" | "menu:palette" => {
                let _ = handler_app.emit(id, ());
            }
            "menu:quit" => quit_via_close(&handler_app, false),
            "tray:toggle" => toggle_main_window(&handler_app),
            "tray:quit" => quit_via_close(&handler_app, true),
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
}
