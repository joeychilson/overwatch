//! The app's own menu, and what choosing an item in it does.
//!
//! Every destination has a shortcut, ⌘[ and ⌘] go back and forward through
//! the window's history, and ⌘F finds: within the conversation a session's
//! page shows, or among the sessions from anywhere else, which ⇧⌘F also does
//! from everywhere. Opening at login belongs to the app rather than to any
//! page, so it sits in the app's own submenu.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The argument the app is opened with at login, which keeps the window closed.
pub const HIDDEN: &str = "--hidden";

/// The label of the app's one window.
const MAIN: &str = "main";
/// The start of an item's id that opens the window at the path after it.
const GO: &str = "go:";
/// The start of an item's id that asks the window to carry out the command
/// after it, which only the window's own page can do.
const COMMAND: &str = "command:";
/// The id of the item that turns opening at login on or off.
const LOGIN: &str = "login";
/// The id of the app's own submenu, which holds [`LOGIN`].
const APP: &str = "app";

/// The app's menu.
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let separator = || PredefinedMenuItem::separator(app);
    let go = |path: &str, text: &str, shortcut: &str| {
        MenuItem::with_id(app, format!("{GO}{path}"), text, true, Some(shortcut))
    };
    let command = |name: &str, text: &str, shortcut: &str| {
        MenuItem::with_id(app, format!("{COMMAND}{name}"), text, true, Some(shortcut))
    };
    Menu::with_items(
        app,
        &[
            &Submenu::with_id_and_items(
                app,
                APP,
                "Overwatch",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &separator()?,
                    &CheckMenuItem::with_id(
                        app,
                        LOGIN,
                        "Open at Login",
                        true,
                        opens_at_login(app),
                        None::<&str>,
                    )?,
                    &separator()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            // Without these, nothing in the window can be copied or pasted.
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                    &separator()?,
                    &Submenu::with_items(
                        app,
                        "Find",
                        true,
                        &[
                            &command("find", "Find…", "CmdOrCtrl+F")?,
                            &command("find_next", "Find Next", "CmdOrCtrl+G")?,
                            &command("find_previous", "Find Previous", "CmdOrCtrl+Shift+G")?,
                        ],
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Go",
                true,
                &[
                    &command("back", "Back", "CmdOrCtrl+[")?,
                    &command("forward", "Forward", "CmdOrCtrl+]")?,
                    &separator()?,
                    &go("/", "Overview", "CmdOrCtrl+1")?,
                    &go("/sessions", "Sessions", "CmdOrCtrl+2")?,
                    &go("/models", "Models", "CmdOrCtrl+3")?,
                    &go("/subscriptions", "Subscriptions", "CmdOrCtrl+4")?,
                    &separator()?,
                    &go("/sessions#search", "Search Sessions", "CmdOrCtrl+Shift+F")?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                    &separator()?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

/// Whether the app opens when the user logs in.
fn opens_at_login<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Do what a chosen item asks.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == LOGIN {
        toggle_login(app);
    } else if let Some(path) = id.strip_prefix(GO) {
        show(app, Some(path));
    } else if let Some(command) = id.strip_prefix(COMMAND) {
        let _ = app.emit_to(MAIN, crate::bridge::COMMAND, command);
    }
}

/// Bring the window forward, at a destination when one is given.
pub fn show<R: Runtime>(app: &AppHandle<R>, path: Option<&str>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(path) = path {
        let _ = app.emit_to(MAIN, crate::bridge::OPEN, path);
    }
}

/// Turn opening at login on or off, and show what is now true in the menu.
fn toggle_login<R: Runtime>(app: &AppHandle<R>) {
    let launcher = app.autolaunch();
    let changed = if opens_at_login(app) {
        launcher.disable()
    } else {
        launcher.enable()
    };
    if let Err(error) = changed {
        eprintln!("overwatch: could not change opening at login: {error}");
    }

    // A check item flips itself when chosen, whether or not the change took.
    let item = app
        .menu()
        .and_then(|menu| menu.get(APP))
        .and_then(|submenu| submenu.as_submenu()?.get(LOGIN))
        .and_then(|item| item.as_check_menuitem().cloned());
    if let Some(item) = item {
        let _ = item.set_checked(opens_at_login(app));
    }
}
