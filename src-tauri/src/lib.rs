//! Overwatch: local history, usage, and cost for coding agents.
//!
//! The engine reads the agents' own history files and keeps a small index of
//! what it found. It does not copy transcripts: a conversation is read from its
//! source file when someone opens it, which is fast because the files are local.
//!
//! The modules are, in the order data moves through them: [`source`] reads an
//! agent's files and prices their usage with [`price`], [`session`] is what
//! those reads produce, [`store`] holds the index, [`index`] keeps it current,
//! and `bridge` answers the window. `account` reads subscription limits from
//! their providers, and `tray` shows them in the menu bar. `card` writes out a
//! picture of a period that the window drew and the reader wants to keep.

mod account;
mod bridge;
mod card;
pub mod error;
pub mod index;
mod price;
pub mod session;
mod shell;
mod source;
pub mod store;
mod timestamp;
mod tray;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

use crate::index::Index;
use crate::session::Provider;

/// How often the engine looks for new activity and redraws the menu bar item
/// while the app is open.
///
/// A pass over an unchanged corpus is a directory walk and a stat per file, so
/// this is cheap enough to run on a timer and quick enough that a conversation
/// finished in another window shows up while the user is still looking at it.
const REFRESH: Duration = Duration::from_secs(5);

/// Build the application and run its desktop event loop.
///
/// The window opens immediately. Scans and reads of each subscription's limits
/// run on background threads and announce themselves when they finish, so none
/// stands between the user and the interface.
///
/// Closing the window hides it rather than quitting, and takes the app out of
/// the Dock, so limits go on being watched from the menu bar and their
/// notifications still arrive; the menu bar item's panel shows it again, as
/// does opening the app. Opened at login, the app waits in the menu bar with
/// its window closed. The window comes back at the size and place it was left.
///
/// # Errors
///
/// Returns a Tauri error if initialization fails, including being unable to
/// open the index in the application data directory.
pub fn run() -> tauri::Result<()> {
    let app = bridge::register(tauri::Builder::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![shell::HIDDEN]),
        ))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Restoring a window that was hidden when the app quit would
                // leave it hidden at the next launch.
                .with_state_flags(StateFlags::all().difference(StateFlags::VISIBLE))
                // The panel goes wherever the menu bar item is.
                .with_denylist(&[tray::PANEL])
                .build(),
        )
        .on_menu_event(|app, event| shell::handle(app, event.id().as_ref()))
        .setup(|app| {
            let home = app.path().home_dir()?;
            let index = Arc::new(Index::open(&app.path().app_data_dir()?, home.clone())?);
            app.manage(Arc::clone(&index));

            app.set_menu(shell::menu(app.handle())?)?;
            // The window starts hidden, so it appears only once it is where it
            // was left. Opened at login, it does not appear at all, and the
            // app stays out of the Dock from the start.
            if std::env::args().any(|arg| arg == shell::HIDDEN) {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            } else {
                shell::show(app.handle(), None);
            }
            tray::create(app.handle())?;

            let (scanned, handle) = (Arc::clone(&index), app.handle().clone());
            std::thread::Builder::new()
                .name("scan".into())
                .spawn(move || refresh(&handle, &scanned))?;
            // One thread per subscription, so a slow provider delays only its
            // own accounts.
            for provider in Provider::ALL {
                let (index, handle, home) =
                    (Arc::clone(&index), app.handle().clone(), home.clone());
                std::thread::Builder::new()
                    .name(format!("limits-{}", provider.key()))
                    .spawn(move || watch_limits(&handle, &index, provider, &home))?;
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == shell::MAIN {
                    shell::hide(window.app_handle());
                } else {
                    let _ = window.hide();
                }
            }
            // The panel closes as a menu does, once anything else is clicked.
            WindowEvent::Focused(false) if window.label() == tray::PANEL => tray::dismiss(window),
            _ => {}
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            shell::show(app, None);
        }
    });
    Ok(())
}

/// Keep the index and the menu bar item current for as long as the app runs.
///
/// The item is drawn before each scan, so the limits kept from the last launch
/// show at once, and on every pass, so a limit whose window has since reset
/// shows refilled.
fn refresh(app: &AppHandle, index: &Index) {
    loop {
        tray::update(app, &index.status().accounts, timestamp::now());
        // A long scan reports as it goes, so the window fills in while files
        // are still being read.
        match index.scan(|status| {
            let _ = app.emit(bridge::CHANGED, status);
        }) {
            Ok(status) => {
                let _ = app.emit(bridge::CHANGED, &status);
                let changed = index.changed();
                if !changed.is_empty() {
                    let _ = app.emit(bridge::SESSIONS_CHANGED, changed);
                }
            }
            // The index keeps what it already had, and the next pass tries again.
            Err(error) => eprintln!("overwatch: scan failed: {error}"),
        }
        std::thread::sleep(REFRESH);
    }
}

/// Keep one subscription's limits current for as long as the app runs, showing
/// each read and notifying what it gave rise to.
fn watch_limits(app: &AppHandle, index: &Index, provider: Provider, home: &Path) {
    account::watch(provider, home, |accounts, alerts| {
        // What was read shows even when it could not be kept.
        if let Err(error) = index.record(provider, accounts) {
            eprintln!(
                "overwatch: could not keep {} limits: {error}",
                provider.key()
            );
        }
        let status = index.status();
        tray::update(app, &status.accounts, timestamp::now());
        let _ = app.emit(bridge::CHANGED, status);
        for alert in alerts {
            let shown = app
                .notification()
                .builder()
                .title(alert.title)
                .body(alert.body)
                .show();
            if let Err(error) = shown {
                eprintln!("overwatch: could not show a notification: {error}");
            }
        }
    });
}
