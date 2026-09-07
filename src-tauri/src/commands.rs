use crate::{
    catalog, credentials,
    data::*,
    error::{AppError, Result},
    index::Index,
    queries::{
        self, HistoryScope, HistoryStatus, SessionNavigation, SessionPage, SessionQuery, ToolUsage,
        UsageReport,
    },
    quota::{self, Quotas},
    settings,
};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AppError::Internal("A native task was interrupted.".into()))?
}
#[tauri::command]
#[specta::specta]
pub async fn get_history_status(index: State<'_, Arc<Index>>) -> Result<HistoryStatus> {
    let index = Arc::clone(&index);
    blocking(move || index.history_status()).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_sessions(
    index: State<'_, Arc<Index>>,
    query: SessionQuery,
) -> Result<SessionPage> {
    let index = Arc::clone(&index);
    blocking(move || queries::sessions(&index, &query)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_session_navigation(
    index: State<'_, Arc<Index>>,
    query: SessionQuery,
    id: String,
) -> Result<SessionNavigation> {
    let index = Arc::clone(&index);
    blocking(move || queries::navigation(&index, &query, &id)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_usage(index: State<'_, Arc<Index>>, scope: HistoryScope) -> Result<UsageReport> {
    let index = Arc::clone(&index);
    blocking(move || queries::usage(&index, &scope)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_tool_stats(
    index: State<'_, Arc<Index>>,
    scope: HistoryScope,
) -> Result<Vec<ToolUsage>> {
    let index = Arc::clone(&index);
    blocking(move || queries::tools(&index, &scope)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_log_allowances(index: State<'_, Arc<Index>>) -> Result<Vec<QuotaSample>> {
    let index = Arc::clone(&index);
    blocking(move || queries::allowances(&index)).await
}
#[tauri::command]
#[specta::specta]
pub async fn refresh_history(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
) -> Result<HistoryStatus> {
    let index = Arc::clone(&index);
    let status = blocking(move || {
        index.scan()?;
        index.history_status()
    })
    .await?;
    IndexChanged::default()
        .emit(&app)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(status)
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
pub async fn preview_source(index: State<'_, Arc<Index>>, source: Source) -> Result<SourcePreview> {
    let index = Arc::clone(&index);
    blocking(move || index.preview_source(source)).await
}
#[tauri::command]
#[specta::specta]
pub async fn save_source_preview(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    preview: SourcePreview,
) -> Result<()> {
    let index = Arc::clone(&index);
    blocking(move || {
        index.save_source_preview(preview)?;
        if let Err(error) = index.scan() {
            eprintln!("Index scan failed after saving sources: {error}");
        }
        Ok(())
    })
    .await?;
    let _ = IndexChanged::default().emit(&app);
    let _ = AccountsChanged.emit(&app);
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn save_sources(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    sources: Vec<Source>,
) -> Result<()> {
    let index = Arc::clone(&index);
    blocking(move || {
        index.set_sources(sources)?;
        // Saving is atomic. A later scan failure is exposed by get_history_status,
        // not reported as a failed settings change after it has committed.
        if let Err(error) = index.scan() {
            eprintln!("Index scan failed after saving sources: {error}");
        }
        Ok(())
    })
    .await?;
    if let Err(error) = IndexChanged::default().emit(&app) {
        eprintln!("Index notification failed after saving sources: {error}");
    }
    if let Err(error) = AccountsChanged.emit(&app) {
        eprintln!("Account notification failed after saving sources: {error}");
    }
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn get_preferences(index: State<'_, Arc<Index>>) -> Result<Preferences> {
    let index = Arc::clone(&index);
    blocking(move || Ok(settings::read(&*index.db.lock()?, "preferences")?.unwrap_or_default()))
        .await
}
#[tauri::command]
#[specta::specta]
pub async fn save_preferences(
    index: State<'_, Arc<Index>>,
    preferences: Preferences,
) -> Result<Preferences> {
    let index = Arc::clone(&index);
    blocking(move || {
        settings::write(&*index.db.lock()?, "preferences", &preferences)?;
        Ok(preferences)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn get_catalog(
    index: State<'_, Arc<Index>>,
    request: CatalogRequest,
) -> Result<CatalogPayload> {
    catalog::read(&index, request).await
}
#[tauri::command]
#[specta::specta]
pub async fn save_catalog(index: State<'_, Arc<Index>>, payload: CatalogPayload) -> Result<()> {
    let index = Arc::clone(&index);
    blocking(move || catalog::save(&index, &payload)).await
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
fn save_file(app: &AppHandle, filename: &str, content: &str) -> Result<Option<String>> {
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
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::write(&path, content)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[tauri::command]
#[specta::specta]
pub async fn export_file(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<Option<String>> {
    blocking(move || save_file(&app, &filename, &content)).await
}
#[tauri::command]
#[specta::specta]
pub async fn export_sessions(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    query: SessionQuery,
) -> Result<Option<String>> {
    let index = Arc::clone(&index);
    blocking(move || {
        save_file(
            &app,
            "overwatch-sessions.csv",
            &queries::export_sessions(&index, &query)?,
        )
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn export_session(
    index: State<'_, Arc<Index>>,
    app: AppHandle,
    id: String,
) -> Result<Option<String>> {
    let index = Arc::clone(&index);
    blocking(move || save_file(&app, "overwatch-session.json", &index.export_session(&id)?)).await
}

pub fn bindings() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            get_history_status,
            get_sessions,
            get_session_navigation,
            get_usage,
            get_tool_stats,
            get_log_allowances,
            refresh_history,
            get_transcript,
            open_session_source,
            get_events,
            preview_source,
            save_source_preview,
            save_sources,
            get_preferences,
            save_preferences,
            get_catalog,
            save_catalog,
            get_accounts,
            refresh_account,
            save_token,
            export_file,
            export_sessions,
            export_session
        ])
        .events(tauri_specta::collect_events![
            IndexChanged,
            AccountsChanged,
            NavigationRequested
        ])
        .dangerously_cast_bigints_to_number()
}
