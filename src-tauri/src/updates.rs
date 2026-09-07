use std::time::Duration;
use tauri::{
    AppHandle,
    menu::{Menu, MenuItem},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

pub fn install(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    // Release configuration supplies the verification key and stable endpoint together.
    let configured = app.config().plugins.0.contains_key("updater");
    if configured {
        app.plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    let item = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        configured,
        None::<&str>,
    )?;
    let items = menu.items()?;
    let parent = if cfg!(target_os = "macos") {
        items.first()
    } else {
        items.last()
    };
    if let Some(parent) = parent.and_then(|item| item.as_submenu()) {
        if cfg!(target_os = "macos") {
            parent.insert(&item, 1)?;
        } else {
            parent.append(&item)?;
        }
    }
    app.on_menu_event(move |app, event| {
        if event.id().as_ref() != "check-updates" || !item.is_enabled().unwrap_or(false) {
            return;
        }
        let _ = item.set_enabled(false);
        let _ = item.set_text("Checking for Updates…");
        let app = app.clone();
        let item = item.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = check(&app, &item).await {
                app.dialog()
                    .message(format!(
                        "The update could not be completed. Please try again.\n\n{error}"
                    ))
                    .title("Update unavailable")
                    .show(|_| {});
            }
            let _ = item.set_text("Check for Updates…");
            let _ = item.set_enabled(true);
        });
    });
    Ok(())
}
async fn check(
    app: &AppHandle,
    item: &MenuItem<tauri::Wry>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let Some(update) = updater.check().await? else {
        app.dialog()
            .message(format!(
                "Overwatch {} is up to date.",
                app.package_info().version
            ))
            .title("No updates available")
            .show(|_| {});
        return Ok(());
    };
    let dialog = app.dialog()
        .message(format!("Overwatch {} is available. Install the update and restart now? Your local history and settings will be kept.", update.version))
        .title("Update Overwatch")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and restart".into(), "Later".into()));
    if !tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await? {
        return Ok(());
    }
    let _ = item.set_text("Downloading Update…");
    // The plugin verifies the artifact signature before installation. Never disable verification.
    update.download_and_install(|_, _| {}, || {}).await?;
    app.restart();
}
