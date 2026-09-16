//! The commands the app's window and the menu bar item's panel call.
//!
//! Each one is a thin wrapper that asks the index and returns the payload.
//! There is no envelope, no revision to carry, no view to open and release, and
//! no cursor: a list request is a filter and an offset.
//!
//! Every command runs on Tauri's thread pool rather than the main thread, so a
//! slow one — a long conversation read for the first time — never stops the
//! window.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};
use crate::index::Index;
use crate::session::{
    Filter, Mark, ModelUsage, Overview, ProjectUsage, Session, SessionPage, Status, Transcript,
};

/// The event emitted when the engine's status changes: after each scan, and
/// after each read of a subscription's limits.
pub const CHANGED: &str = "index_changed";

/// The event asking the window to show a destination, carrying its path.
pub const OPEN: &str = "open";

/// One page of the session list, with the totals of the whole match.
#[tauri::command(async)]
pub fn list_sessions(index: State<'_, Arc<Index>>, filter: Filter) -> Result<SessionPage> {
    index.read(|store| store.list(&filter))
}

/// One session's summary.
#[tauri::command(async)]
pub fn get_session(index: State<'_, Arc<Index>>, id: String) -> Result<Session> {
    index
        .read(|store| store.get(&id))?
        .ok_or_else(|| Error::NotFound(format!("session {id}")))
}

/// A window of one session's conversation, read from its source file.
///
/// `offset` counts readable turns, not source records. The whole conversation
/// is parsed once and held, so paging through it costs nothing further.
#[tauri::command(async)]
pub fn get_transcript(
    index: State<'_, Arc<Index>>,
    id: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Transcript> {
    index.transcript(&id, offset.unwrap_or(0), limit.unwrap_or(200))
}

/// Where every turn of a session's conversation falls, for its timeline.
#[tauri::command(async)]
pub fn get_timeline(index: State<'_, Arc<Index>>, id: String) -> Result<Vec<Mark>> {
    index.timeline(&id)
}

/// Release the held conversation when the reader leaves it.
#[tauri::command(async)]
pub fn close_transcript(index: State<'_, Arc<Index>>) {
    index.close();
}

/// Show the file a session's history is in, in the file manager.
#[tauri::command(async)]
pub fn reveal_session<R: Runtime>(
    app: AppHandle<R>,
    index: State<'_, Arc<Index>>,
    id: String,
) -> Result<()> {
    let (unit, _) = index
        .read(|store| store.locate(&id))?
        .ok_or_else(|| Error::NotFound(format!("session {id}")))?;
    app.opener()
        .reveal_item_in_dir(&unit.path)
        .map_err(|error| Error::Open(error.to_string()))
}

/// Open the folder a session worked in.
#[tauri::command(async)]
pub fn open_session_folder<R: Runtime>(
    app: AppHandle<R>,
    index: State<'_, Arc<Index>>,
    id: String,
) -> Result<()> {
    let folder = index
        .read(|store| store.get(&id))?
        .and_then(|session| session.cwd)
        .ok_or_else(|| Error::NotFound(format!("the folder of session {id}")))?;
    app.opener()
        .open_path(folder, None::<&str>)
        .map_err(|error| Error::Open(error.to_string()))
}

/// Models ranked by recorded usage over a period.
#[tauri::command(async)]
pub fn list_models(
    index: State<'_, Arc<Index>>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<Vec<ModelUsage>> {
    index.read(|store| store.models(since, until))
}

/// Projects ranked by recorded usage over a period.
#[tauri::command(async)]
pub fn list_projects(
    index: State<'_, Arc<Index>>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<Vec<ProjectUsage>> {
    index.read(|store| store.projects(since, until))
}

/// Totals for the overview, in this machine's local days.
#[tauri::command(async)]
pub fn get_overview(
    index: State<'_, Arc<Index>>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<Overview> {
    index.read(|store| store.overview(since, until))
}

/// What indexing has done so far. Never waits for a scan.
#[tauri::command(async)]
pub fn get_status(index: State<'_, Arc<Index>>) -> Status {
    let mut status = index.status();
    status.agents = index.agents().into_iter().map(|(agent, _)| agent).collect();
    status
}

/// Write a picture of a period the window drew to the Desktop, and answer with
/// where it went.
///
/// `png` carries the image's bytes in base64. The Desktop is where a saved file
/// is hardest to lose; without one, the home directory stands in. A name
/// already taken gets a number rather than displacing what is there.
///
/// # Errors
///
/// Returns an error when the image is not a PNG, when neither folder can be
/// found, or when the file cannot be written.
#[tauri::command(async)]
pub fn save_card<R: Runtime>(app: AppHandle<R>, name: String, png: String) -> Result<String> {
    let bytes = crate::card::decode(&png)?;
    let folder = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| Error::Open(error.to_string()))?;
    let path = crate::card::write(&folder, &name, &bytes)?;
    Ok(path.display().to_string())
}

/// Bring the app's window forward, at a destination when one is given.
#[tauri::command(async)]
pub fn open_window<R: Runtime>(app: AppHandle<R>, path: Option<String>) {
    crate::shell::show(&app, path.as_deref());
}

/// Quit the app, which the menu bar item's panel offers since closing the
/// window does not.
#[tauri::command(async)]
pub fn quit<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/// Register every command on the builder.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        list_sessions,
        get_session,
        get_transcript,
        get_timeline,
        close_transcript,
        reveal_session,
        open_session_folder,
        list_models,
        list_projects,
        get_overview,
        get_status,
        save_card,
        open_window,
        quit,
    ])
}
