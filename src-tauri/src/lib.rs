mod catalog;
mod commands;
mod credentials;
pub mod data;
pub mod error;
pub mod history;
pub mod index;
mod navigation;
mod opencode;
mod parse;
pub mod queries;
mod quota;
mod settings;
mod sources;
mod timeline;
mod updates;
mod watch;

use std::sync::Arc;
use tauri::Manager;
use tauri_specta::Event;

pub fn export_bindings() -> std::result::Result<(), Box<dyn std::error::Error>> {
    commands::bindings().export(
        specta_typescript::Typescript::default(),
        concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/bindings.ts"),
    )?;
    Ok(())
}
pub fn run() {
    if let Err(error) = run_app() {
        eprintln!("Overwatch could not start: {error}");
        std::process::exit(1);
    }
}
fn run_app() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let bindings = commands::bindings();
    #[cfg(debug_assertions)]
    export_bindings()?;
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window
                    .show()
                    .and_then(|()| window.unminimize())
                    .and_then(|()| window.set_focus())
            {
                eprintln!("Could not focus Overwatch: {error}");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(bindings.invoke_handler())
        .setup(move |app| {
            bindings.mount_events(app);
            navigation::install(app.handle())?;
            let index = Arc::new(index::Index::open(
                app.path().app_data_dir()?,
                index::default_sources()?,
            )?);
            let quotas = Arc::new(quota::Quotas::new()?);
            app.manage(Arc::clone(&index));
            app.manage(Arc::clone(&quotas));
            let handle = app.handle().clone();
            let scanner = Arc::clone(&index);
            std::thread::spawn(move || {
                watch::run(scanner, move |event| {
                    if let Err(error) = event.emit(&handle) {
                        eprintln!("Index notification failed: {error}");
                    }
                })
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match quota::read(&index) {
                        Ok(state) => {
                            for account in state.accounts.into_iter().filter(|account| {
                                account.next_refresh_at <= chrono::Utc::now().timestamp_millis()
                            }) {
                                match quotas
                                    .refresh(Arc::clone(&index), account.agent, false)
                                    .await
                                {
                                    Ok(_) => {
                                        if let Err(error) = data::AccountsChanged.emit(&handle) {
                                            eprintln!("Account notification failed: {error}");
                                        }
                                    }
                                    Err(error) => eprintln!("Account refresh failed: {error}"),
                                }
                            }
                        }
                        Err(error) => eprintln!("Account history unavailable: {error}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}
