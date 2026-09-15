//! Overwatch desktop executable.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> tauri::Result<()> {
    overwatch_lib::run()
}
