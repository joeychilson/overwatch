//! Overwatch: local history, usage, and cost for coding agents.
//!
//! The engine reads the agents' own history files and keeps a small index of
//! what it found. It does not copy transcripts: a conversation is read from its
//! source file when someone opens it, which is fast because the files are local
//! and because nothing else has to happen first.
//!
//! The modules are, in the order data moves through them: [`source`] reads an
//! agent's files and prices their usage with [`price`], [`session`] is what
//! those reads produce, [`store`] holds the index, [`index`] keeps it current,
//! and [`bridge`] answers the window. [`account`] reads subscription limits
//! from their providers, and the menu bar item shows them. [`card`] writes out
//! a picture of a period that the window drew and the reader wants to keep.

pub mod account;
pub mod bridge;
pub mod card;
pub mod error;
pub mod index;
pub mod price;
pub mod session;
mod shell;
pub mod source;
pub mod store;
pub mod timestamp;
mod tray;

use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

use crate::index::Index;
use crate::session::Provider;

/// How often the engine looks for new activity while the app is open.
///
/// A pass over an unchanged corpus is a directory walk and a stat per file, so
/// this is cheap enough to run on a timer and quick enough that a conversation
/// finished in another window shows up while the user is still looking at it.
const REFRESH: Duration = Duration::from_secs(5);

/// How often the menu bar item is redrawn between reads of limits, so that its
/// countdowns stay true to the minute.
const TICK: Duration = Duration::from_secs(30);

/// The user's home directory.
fn home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

/// Build the application and run its desktop event loop.
///
/// The window opens immediately. The first scan and the first read of each
/// subscription's limits run on background threads and announce themselves
/// when they finish, so neither stands between the user and the interface.
///
/// Closing the window hides it rather than quitting, so limits go on being
/// watched and their notifications still arrive; clicking the Dock icon or
/// opening it from the menu bar item's panel shows it again, and quitting
/// quits. Opened at login, the app waits in the menu bar with its window
/// closed. The window comes back at the size and place it was left.
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
            let data_dir = app.path().app_data_dir()?;
            let index = Arc::new(Index::open(&data_dir, home())?);
            app.manage(Arc::clone(&index));

            app.set_menu(shell::menu(app.handle())?)?;
            // The window starts hidden, so it appears only once it is where it
            // was left, and not at all when the app is opened at login.
            if !std::env::args().any(|arg| arg == shell::HIDDEN) {
                shell::show(app.handle(), None);
            }

            tray::create(app.handle())?;
            let watched = Arc::clone(&index);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    tray::update(&handle, &watched.status().accounts, timestamp::now());
                    std::thread::sleep(TICK);
                }
            });

            let scanner = Arc::clone(&index);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    // A long scan reports as it goes, so the window fills in
                    // while files are still being read.
                    match scanner.scan(|status| {
                        let _ = handle.emit(bridge::CHANGED, status);
                    }) {
                        Ok(status) => {
                            let _ = handle.emit(bridge::CHANGED, &status);
                        }
                        Err(error) => {
                            // A failed scan is not fatal: the index keeps what
                            // it already had and the next pass tries again.
                            eprintln!("overwatch: scan failed: {error}");
                        }
                    }
                    std::thread::sleep(REFRESH);
                }
            });

            // One thread per subscription, so a slow provider delays only its
            // own accounts.
            for provider in Provider::ALL {
                let index = Arc::clone(&index);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    account::watch(provider, &home(), |accounts, alerts| {
                        // What was read shows even when it could not be kept.
                        if let Err(error) = index.record(provider, accounts) {
                            eprintln!(
                                "overwatch: could not keep {} limits: {error}",
                                provider.key()
                            );
                        }
                        let status = index.status();
                        tray::update(&handle, &status.accounts, timestamp::now());
                        let _ = handle.emit(bridge::CHANGED, status);
                        for alert in alerts {
                            let shown = handle
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
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
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
