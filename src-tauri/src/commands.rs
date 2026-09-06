use crate::{
    catalog, credentials,
    data::*,
    error::{AppError, Result},
    index::Index,
    quota::{self, Quotas},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;

fn store_json(app: &AppHandle, key: &str, value: impl Serialize) -> Result<()> {
    let store = app
        .store("settings.json")
        .map_err(|e| AppError::Io(e.to_string()))?;
    let previous = store.get(key);
    store.set(key, serde_json::to_value(&value)?);
    if let Err(error) = store.save() {
        match previous {
            Some(previous) => store.set(key, previous),
            None => {
                store.delete(key);
            }
        }
        return Err(AppError::Io(error.to_string()));
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AppError::Internal("A native task was interrupted.".into()))?
}
#[tauri::command]
#[specta::specta]
pub async fn get_snapshot(index: State<'_, Arc<Index>>) -> Result<Snapshot> {
    let index = Arc::clone(&index);
    blocking(move || index.snapshot()).await
}
#[tauri::command]
#[specta::specta]
pub async fn refresh_index(index: State<'_, Arc<Index>>, app: AppHandle) -> Result<Snapshot> {
    let index = Arc::clone(&index);
    let snapshot = blocking(move || {
        index.scan()?;
        index.snapshot()
    })
    .await?;
    IndexChanged
        .emit(&app)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(snapshot)
}
#[tauri::command]
#[specta::specta]
pub async fn get_transcript(index: State<'_, Arc<Index>>, id: String) -> Result<Transcript> {
    let index = Arc::clone(&index);
    blocking(move || index.transcript(&id)).await
}
#[tauri::command]
#[specta::specta]
pub async fn open_session_source(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    id: String,
) -> Result<()> {
    let index = Arc::clone(&index);
    blocking(move || {
        let path = index.source_path(&id)?;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| AppError::Io(error.to_string()))
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn get_events(
    index: State<'_, Arc<Index>>,
    id: String,
    offset: u32,
    search: String,
) -> Result<EventPage> {
    let index = Arc::clone(&index);
    blocking(move || index.events(&id, offset, &search)).await
}
#[tauri::command]
#[specta::specta]
pub async fn save_sources(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    sources: Vec<Source>,
) -> Result<Snapshot> {
    let index = Arc::clone(&index);
    blocking(move || {
        crate::index::validate_sources(&sources)?;
        store_json(&app, "sources", &sources)?;
        index.set_sources(sources)?;
        index.scan()?;
        IndexChanged
            .emit(&app)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        AccountsChanged
            .emit(&app)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        index.snapshot()
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub fn get_preferences(app: AppHandle) -> Result<Preferences> {
    let store = app
        .store("settings.json")
        .map_err(|e| AppError::Io(e.to_string()))?;
    store
        .get("preferences")
        .map(serde_json::from_value)
        .transpose()
        .map(|value| value.unwrap_or_default())
        .map_err(Into::into)
}
#[tauri::command]
#[specta::specta]
pub fn save_preferences(app: AppHandle, preferences: Preferences) -> Result<Preferences> {
    store_json(&app, "preferences", &preferences)?;
    Ok(preferences)
}
#[tauri::command]
#[specta::specta]
pub async fn get_catalog(
    index: State<'_, Arc<Index>>,
    request: CatalogRequest,
) -> Result<CatalogPayload> {
    catalog::read(&index.directory, request).await
}
#[tauri::command]
#[specta::specta]
pub async fn save_catalog(index: State<'_, Arc<Index>>, payload: CatalogPayload) -> Result<()> {
    let index = Arc::clone(&index);
    blocking(move || catalog::save(&index.directory, &payload)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_accounts(index: State<'_, Arc<Index>>) -> Result<Accounts> {
    let index = Arc::clone(&index);
    blocking(move || quota::read(&index)).await
}
#[tauri::command]
#[specta::specta]
pub async fn refresh_account(
    index: State<'_, Arc<Index>>,
    quotas: State<'_, Arc<Quotas>>,
    app: AppHandle,
    agent: Agent,
) -> Result<AccountStatus> {
    let status = quotas.refresh(Arc::clone(&index), agent, true).await?;
    AccountsChanged
        .emit(&app)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(status)
}
#[tauri::command]
#[specta::specta]
pub async fn save_token(
    index: State<'_, Arc<Index>>,
    quotas: State<'_, Arc<Quotas>>,
    app: AppHandle,
    agent: Agent,
    token: Option<String>,
) -> Result<()> {
    let _guard = quotas.lock(agent).await?;
    let index = Arc::clone(&index);
    blocking(move || {
        credentials::save(agent, token.as_deref())?;
        quota::clear(&index, agent)
    })
    .await?;
    AccountsChanged
        .emit(&app)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}
fn save_file(app: &AppHandle, filename: &str, content: &str) -> Result<bool> {
    let name = std::path::Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidData("Invalid export filename".into()))?;
    let extension = if name.ends_with(".csv") {
        "csv"
    } else {
        "json"
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("Overwatch export", &[extension])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::write(path, content)?;
    Ok(true)
}
#[tauri::command]
#[specta::specta]
pub async fn export_file(app: AppHandle, filename: String, content: String) -> Result<bool> {
    blocking(move || save_file(&app, &filename, &content)).await
}
#[tauri::command]
#[specta::specta]
pub async fn export_session(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    id: String,
) -> Result<bool> {
    let index = Arc::clone(&index);
    blocking(move || save_file(&app, "overwatch-session.json", &index.export_session(&id)?)).await
}

pub fn bindings() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            get_snapshot,
            refresh_index,
            get_transcript,
            open_session_source,
            get_events,
            save_sources,
            get_preferences,
            save_preferences,
            get_catalog,
            save_catalog,
            get_accounts,
            refresh_account,
            save_token,
            export_file,
            export_session
        ])
        .events(tauri_specta::collect_events![IndexChanged, AccountsChanged])
        .dangerously_cast_bigints_to_number()
}
