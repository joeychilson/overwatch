use crate::{
    data::*,
    error::{AppError, Result},
    opencode,
    parse::{Accumulator, Cursor},
    settings,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use walkdir::WalkDir;

pub struct Index {
    pub directory: PathBuf,
    pub db: Mutex<Connection>,
    pub(crate) sources: Mutex<Vec<SourceStatus>>,
    cursors: Mutex<HashMap<String, Cursor>>,
    reader: Mutex<Option<Reader>>,
    pub scanning: AtomicBool,
    scan_error: Mutex<Option<AppError>>,
    invalid_summaries: Mutex<HashSet<String>>,
}
struct Reader {
    source: String,
    stamp: String,
    data: ReaderData,
    search: Option<(String, Vec<u32>)>,
}
enum ReaderData {
    Jsonl(Box<Cursor>),
    Sqlite(Box<Accumulator>),
}
impl ReaderData {
    fn events(&self) -> &[SessionEvent] {
        match self {
            Self::Jsonl(cursor) => &cursor.data.events,
            Self::Sqlite(data) => &data.events,
        }
    }
    fn summary(&self) -> Session {
        match self {
            Self::Jsonl(cursor) => cursor.summary(),
            Self::Sqlite(data) => data.summary(),
        }
    }
}

pub fn default_sources() -> Result<Vec<Source>> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::NotFound("Home directory is unavailable".into()))?;
    let xdg = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Ok(Agent::ALL
        .into_iter()
        .map(|agent| {
            let path = match agent {
                Agent::Codex => std::env::var_os("CODEX_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex")),
                Agent::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".claude")),
                Agent::Opencode => xdg.join("opencode"),
                Agent::Pi => home.join(".pi/agent"),
                Agent::Grok => home.join(".grok"),
                Agent::Antigravity => home.join(".gemini/antigravity"),
            };
            Source {
                agent,
                path: path.to_string_lossy().into_owned(),
                enabled: agent != Agent::Antigravity,
            }
        })
        .collect())
}
pub fn validate_sources(sources: &[Source]) -> Result<()> {
    let unique: HashSet<_> = sources.iter().map(|s| s.agent).collect();
    if unique.len() != Agent::ALL.len() || sources.len() != Agent::ALL.len() {
        return Err(AppError::InvalidData(
            "Configure each agent exactly once.".into(),
        ));
    }
    if sources.iter().any(|s| !Path::new(&s.path).is_absolute()) {
        return Err(AppError::InvalidData(
            "Source folders must be absolute paths.".into(),
        ));
    }
    Ok(())
}
fn stamp(path: &Path) -> Result<String> {
    let meta = path.metadata()?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::InvalidData("Source timestamp precedes the Unix epoch".into()))?
        .as_nanos();
    Ok(format!("{}:{modified}", meta.len()))
}
fn history_stamp(agent: Agent, path: &Path) -> Result<String> {
    let mut current = stamp(path)?;
    if agent == Agent::Grok {
        let summary = path.with_file_name("summary.json");
        if summary.try_exists()? {
            current.push('|');
            current.push_str(&stamp(&summary)?);
        }
    }
    Ok(current)
}
fn split_opencode_source(source: &str) -> Result<(&str, &str)> {
    source
        .rsplit_once('#')
        .ok_or_else(|| AppError::InvalidData("Invalid OpenCode source".into()))
}
impl Index {
    pub fn open(directory: PathBuf, sources: Vec<Source>) -> Result<Self> {
        validate_sources(&sources)?;
        std::fs::create_dir_all(&directory)?;
        let mut db = Connection::open(directory.join("history.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
            CREATE TABLE IF NOT EXISTS sessions(source TEXT PRIMARY KEY, agent TEXT NOT NULL, id TEXT NOT NULL, stamp TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS session_id ON sessions(id,updated DESC);
            CREATE TABLE IF NOT EXISTS accounts(agent TEXT PRIMARY KEY,root TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS samples(agent TEXT NOT NULL,identity TEXT NOT NULL,bucket TEXT NOT NULL,reset INTEGER NOT NULL,minute INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(agent,identity,bucket,reset,minute));")?;
        let sources = settings::initialize(&mut db, &directory, sources)?;
        Ok(Self {
            directory,
            db: Mutex::new(db),
            sources: Mutex::new(
                sources
                    .into_iter()
                    .map(|source| SourceStatus {
                        source,
                        available: false,
                        sessions: 0,
                        issues: vec![],
                    })
                    .collect(),
            ),
            cursors: Mutex::new(HashMap::new()),
            reader: Mutex::new(None),
            scanning: AtomicBool::new(false),
            scan_error: Mutex::new(None),
            invalid_summaries: Mutex::new(HashSet::new()),
        })
    }
    pub fn sources(&self) -> Result<Vec<Source>> {
        Ok(self
            .sources
            .lock()?
            .iter()
            .map(|s| s.source.clone())
            .collect())
    }
    pub fn set_sources(&self, sources: Vec<Source>) -> Result<()> {
        validate_sources(&sources)?;
        let _scan = self.cursors.lock()?;
        let mut statuses = self.sources.lock()?;
        let mut db = self.db.lock()?;
        let tx = db.transaction()?;
        settings::write(&tx, "sources", &sources)?;
        for source in &sources {
            if statuses
                .iter()
                .any(|s| s.source.agent == source.agent && s.source.path != source.path)
            {
                tx.execute("DELETE FROM accounts WHERE agent=?1", [source.agent.id()])?;
                tx.execute("DELETE FROM samples WHERE agent=?1", [source.agent.id()])?;
                tx.execute("DELETE FROM sessions WHERE agent=?1", [source.agent.id()])?;
            }
        }
        tx.commit()?;
        *statuses = sources
            .into_iter()
            .map(|source| SourceStatus {
                source,
                available: false,
                sessions: 0,
                issues: vec![],
            })
            .collect();
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        if let Some(error) = self.scan_error.lock()?.as_ref() {
            return Err(error.clone());
        }
        let mut sources = self.sources.lock()?.clone();
        let db = self.db.lock()?;
        let mut query =
            db.prepare("SELECT source,agent,data FROM sessions ORDER BY updated DESC")?;
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for row in query.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (key, agent, raw) = row?;
            let Some(source) = sources
                .iter_mut()
                .find(|source| source.source.agent.id() == agent && source.source.enabled)
            else {
                continue;
            };
            let mut session: Session = match serde_json::from_str(&raw) {
                Ok(session) => session,
                Err(_) => {
                    // Keep the damaged cache row until its original history can be read.
                    // Mark it for repair even when the file's modification stamp is unchanged.
                    self.invalid_summaries.lock()?.insert(key.clone());
                    source.issues.push(format!("An unreadable cached session is excluded from totals: {key}. Rescan sources to rebuild it from the original history."));
                    continue;
                }
            };
            session.limits.retain(|sample| !sample.is_codex_spark());
            if seen.insert(session.id.clone()) {
                sessions.push(session);
            }
        }
        for source in &mut sources {
            source.sessions = sessions
                .iter()
                .filter(|s| s.agent == source.source.agent)
                .count() as u32;
        }
        Ok(Snapshot {
            sessions,
            sources,
            scanning: self.scanning.load(Ordering::Relaxed),
        })
    }
    pub fn scan(&self) -> Result<bool> {
        let result = self.scan_files();
        let mut error = self.scan_error.lock()?;
        let recovered = error.is_some() && result.is_ok();
        *error = result.as_ref().err().cloned();
        result.map(|changed| changed || recovered)
    }
    fn scan_files(&self) -> Result<bool> {
        let mut cursors = self.cursors.lock()?;
        self.scanning.store(true, Ordering::Relaxed);
        struct Reset<'a>(&'a AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Relaxed);
            }
        }
        let _reset = Reset(&self.scanning);
        let sources = self.sources()?;
        let invalid = self.invalid_summaries.lock()?.clone();
        for key in &invalid {
            cursors.remove(key);
        }
        let stamps: HashMap<String, String> = {
            let db = self.db.lock()?;
            let mut query = db.prepare("SELECT source,stamp FROM sessions")?;
            query
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?
        };
        let mut statuses = Vec::new();
        let mut changed = false;
        let mut pending = Vec::new();
        let mut retained = HashSet::new();
        for source in sources {
            let mut status = SourceStatus {
                available: Path::new(&source.path).is_dir(),
                source,
                sessions: 0,
                issues: vec![],
            };
            let mut found = HashSet::new();
            if status.available && status.source.enabled {
                let root = Path::new(&status.source.path);
                if status.source.agent == Agent::Opencode {
                    let path = root.join("opencode.db");
                    if path.exists() {
                        let result = (|| -> Result<()> {
                            let database = opencode::Database::open(&path)?;
                            for (id, updated) in database.sessions()? {
                                let key = format!("{}#{id}", path.display());
                                found.insert(key.clone());
                                let stamp = updated.to_string();
                                if stamps.get(&key) == Some(&stamp) && !invalid.contains(&key) {
                                    continue;
                                }
                                match database.read(&id, false) {
                                    Ok(data) => pending.push((key, stamp, data.summary())),
                                    Err(error) => status.issues.push(error.to_string()),
                                }
                                if pending.len() >= 32 {
                                    self.commit(&mut pending)?;
                                    changed = true;
                                }
                            }
                            Ok(())
                        })();
                        if let Err(error) = result {
                            status.issues.push(error.to_string());
                        }
                    } else {
                        status.issues.push(format!(
                            "No OpenCode database was found at {}.",
                            path.display()
                        ));
                    }
                } else if status.source.agent != Agent::Antigravity {
                    let folders: &[&str] = match status.source.agent {
                        Agent::Codex => &["sessions", "archived_sessions"],
                        Agent::Claude => &["projects"],
                        _ => &["sessions"],
                    };
                    let mut recognized = false;
                    for folder in folders {
                        let directory = root.join(folder);
                        if !directory.is_dir() {
                            continue;
                        }
                        recognized = true;
                        for entry in WalkDir::new(directory).follow_links(false) {
                            let entry = match entry {
                                Ok(entry) => entry,
                                Err(error) => {
                                    status.issues.push(error.to_string());
                                    continue;
                                }
                            };
                            if !entry.file_type().is_file()
                                || entry.path().extension().is_none_or(|ext| ext != "jsonl")
                                || (status.source.agent == Agent::Grok
                                    && entry.file_name() != "updates.jsonl")
                            {
                                continue;
                            }
                            let key = entry.path().to_string_lossy().into_owned();
                            found.insert(key.clone());
                            let result = (|| -> Result<()> {
                                let current = history_stamp(status.source.agent, entry.path())?;
                                if stamps.get(&key) == Some(&current) && !invalid.contains(&key) {
                                    return Ok(());
                                }
                                let cursor = cursors.entry(key.clone()).or_insert_with(|| {
                                    Cursor::new(status.source.agent, entry.path(), false)
                                });
                                cursor.read(entry.path())?;
                                pending.push((key.clone(), current, cursor.summary()));
                                retained.insert(key.clone());
                                if cursors.len() > 32 {
                                    let oldest = cursors
                                        .iter()
                                        .min_by_key(|(_, cursor)| cursor.data.session.updated_at)
                                        .map(|(key, _)| key.clone());
                                    if let Some(oldest) = oldest {
                                        cursors.remove(&oldest);
                                    }
                                }
                                Ok(())
                            })();
                            if let Err(error) = result {
                                status
                                    .issues
                                    .push(format!("{}: {error}", entry.path().display()));
                            }
                            if pending.len() >= 32 {
                                self.commit(&mut pending)?;
                                changed = true;
                            }
                        }
                    }
                    if !recognized {
                        status.issues.push(format!(
                            "No recognized {} history folders were found under {}.",
                            status.source.agent.id(),
                            root.display()
                        ));
                    }
                }
                if status.issues.is_empty() {
                    let db = self.db.lock()?;
                    let mut query = db.prepare("SELECT source FROM sessions WHERE agent=?1")?;
                    let previous = query
                        .query_map([status.source.agent.id()], |r| r.get::<_, String>(0))?
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    for key in previous.into_iter().filter(|key| !found.contains(key)) {
                        db.execute("DELETE FROM sessions WHERE source=?1", [&key])?;
                        cursors.remove(&key);
                        changed = true;
                    }
                }
            }
            statuses.push(status);
        }
        if !pending.is_empty() {
            self.commit(&mut pending)?;
            changed = true;
        }
        // Keep only recent append cursors, bounding idle memory independently of history size.
        let cutoff = chrono::Utc::now().timestamp_millis() - 10 * 60_000;
        cursors.retain(|key, cursor| {
            retained.contains(key) || cursor.data.session.updated_at >= cutoff
        });
        if cursors.len() > 32 {
            let mut keys: Vec<_> = cursors
                .iter()
                .map(|(key, cursor)| (key.clone(), cursor.data.session.updated_at))
                .collect();
            keys.sort_by_key(|(_, timestamp)| std::cmp::Reverse(*timestamp));
            for (key, _) in keys.into_iter().skip(32) {
                cursors.remove(&key);
            }
        }
        let mut previous = self.sources.lock()?;
        changed |= previous
            .iter()
            .zip(&statuses)
            .any(|(a, b)| a.available != b.available || a.issues != b.issues);
        *previous = statuses;
        Ok(changed)
    }
    fn commit(&self, pending: &mut Vec<(String, String, Session)>) -> Result<()> {
        let mut db = self.db.lock()?;
        let tx = db.transaction()?;
        for (source, stamp, session) in pending.iter() {
            tx.prepare_cached("INSERT OR REPLACE INTO sessions VALUES(?1,?2,?3,?4,?5,?6)")?
                .execute(params![
                    source,
                    session.agent.id(),
                    session.id,
                    stamp,
                    session.updated_at,
                    serde_json::to_string(session)?
                ])?;
        }
        tx.commit()?;
        let mut invalid = self.invalid_summaries.lock()?;
        for (source, _, _) in pending.iter() {
            invalid.remove(source);
        }
        pending.clear();
        Ok(())
    }
    fn indexed_source(&self, id: &str) -> Result<(Agent, String, String)> {
        let (agent, source, stamp): (String, String, String) = {
            let db = self.db.lock()?;
            db.query_row(
                "SELECT agent,source,stamp FROM sessions WHERE id=?1 ORDER BY updated DESC LIMIT 1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("This session is no longer indexed.".into()))?
        };
        let agent = self
            .sources
            .lock()?
            .iter()
            .find(|s| s.source.agent.id() == agent && s.source.enabled)
            .map(|s| s.source.agent)
            .ok_or_else(|| AppError::NotFound("This source is disabled.".into()))?;
        Ok((agent, source, stamp))
    }
    pub fn source_path(&self, id: &str) -> Result<PathBuf> {
        let (agent, source, _) = self.indexed_source(id)?;
        if agent == Agent::Opencode {
            let (path, _) = split_opencode_source(&source)?;
            Ok(PathBuf::from(path))
        } else {
            Ok(PathBuf::from(source))
        }
    }
    fn with_reader<T>(&self, id: &str, read: impl FnOnce(&mut Reader) -> Result<T>) -> Result<T> {
        let (agent, source, stamp) = self.indexed_source(id)?;
        let mut cache = self.reader.lock()?;
        let current = if agent == Agent::Opencode {
            stamp
        } else {
            history_stamp(agent, Path::new(&source))?
        };
        if cache.as_ref().is_none_or(|reader| reader.source != source) {
            let data = if agent == Agent::Opencode {
                let (path, sid) = split_opencode_source(&source)?;
                ReaderData::Sqlite(Box::new(
                    opencode::Database::open(Path::new(path))?.read(sid, true)?,
                ))
            } else {
                let path = Path::new(&source);
                let mut cursor = Cursor::new(agent, path, true);
                cursor.read(path)?;
                ReaderData::Jsonl(Box::new(cursor))
            };
            *cache = Some(Reader {
                source,
                stamp: current.clone(),
                data,
                search: None,
            });
        }
        let reader = cache
            .as_mut()
            .ok_or_else(|| AppError::Internal("Transcript cache is unavailable".into()))?;
        if reader.stamp != current {
            // Tool results and rewrites can change existing events, not just append new ones.
            reader.search = None;
            match &mut reader.data {
                ReaderData::Jsonl(cursor) => cursor.read(Path::new(&reader.source))?,
                ReaderData::Sqlite(data) => {
                    let (path, sid) = split_opencode_source(&reader.source)?;
                    **data = opencode::Database::open(Path::new(path))?.read(sid, true)?;
                }
            }
            reader.stamp = current;
        }
        read(reader)
    }
    pub fn transcript(&self, id: &str) -> Result<Transcript> {
        self.with_reader(id, |reader| {
            let data = &reader.data;
            Ok(Transcript {
                session: data.summary(),
                timeline: data
                    .events()
                    .iter()
                    .enumerate()
                    .map(|(index, event)| TimelineEvent {
                        index: index as u32,
                        kind: event.kind,
                        timestamp: event.timestamp,
                        duration_ms: event.duration_ms,
                        tool: event.tool.clone(),
                        failed: event.failed,
                    })
                    .collect(),
            })
        })
    }
    pub fn events(&self, id: &str, offset: u32, search: &str) -> Result<EventPage> {
        self.with_reader(id, |reader| {
            let events = reader.data.events();
            let search = search.to_lowercase();
            if !search.is_empty()
                && reader
                    .search
                    .as_ref()
                    .is_none_or(|(query, _)| *query != search)
            {
                let matches = events
                    .iter()
                    .enumerate()
                    .filter(|(_, event)| {
                        event.text.to_lowercase().contains(&search)
                            || event
                                .output
                                .as_ref()
                                .is_some_and(|s| s.to_lowercase().contains(&search))
                            || event
                                .tool
                                .as_ref()
                                .is_some_and(|s| s.to_lowercase().contains(&search))
                    })
                    .map(|(i, _)| i as u32)
                    .collect();
                // Retain only the current query's indices; bodies stay in the existing reader.
                reader.search = Some((search.clone(), matches));
            }
            let matches = reader
                .search
                .as_ref()
                .filter(|_| !search.is_empty())
                .map(|(_, matches)| matches);
            let total = matches.map_or(events.len(), Vec::len) as u32;
            let offset = offset.min(total.saturating_sub(1) / 100 * 100);
            let end = (offset.saturating_add(100)).min(total) as usize;
            let page_matches = matches
                .map(|matches| matches[offset as usize..end].to_vec())
                .unwrap_or_default();
            let events = if matches.is_some() {
                page_matches
                    .iter()
                    .map(|i| events[*i as usize].clone())
                    .collect()
            } else {
                events[offset as usize..end].to_vec()
            };
            Ok(EventPage {
                events,
                offset,
                total,
                matches: page_matches,
            })
        })
    }
    pub fn export_session(&self, id: &str) -> Result<String> {
        self.with_reader(id, |reader| {
            let data = &reader.data;
            Ok(serde_json::to_string_pretty(
                &serde_json::json!({"session": data.summary(), "events": data.events()}),
            )?)
        })
    }
}
