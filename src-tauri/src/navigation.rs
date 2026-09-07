use crate::data::NavigationRequested;
use tauri::{
    AppHandle,
    menu::{Menu, MenuItem, Submenu},
};
use tauri_specta::Event;

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let back = MenuItem::with_id(app, "navigate-back", "Back", true, Some("CmdOrCtrl+["))?;
    let forward = MenuItem::with_id(
        app,
        "navigate-forward",
        "Forward",
        true,
        Some("CmdOrCtrl+]"),
    )?;
    let go = Submenu::with_items(app, "Go", true, &[&back, &forward])?;
    // Preserve standard Edit, Window, Help and macOS application commands.
    let position = menu.items()?.len().saturating_sub(2);
    menu.insert(&go, position)?;
    crate::updates::install(app, &menu)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let navigation = match event.id().as_ref() {
            "navigate-back" => NavigationRequested::Back,
            "navigate-forward" => NavigationRequested::Forward,
            _ => return,
        };
        if let Err(error) = navigation.emit(app) {
            eprintln!("Navigation action failed: {error}");
        }
    });
    Ok(())
}
