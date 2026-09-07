//! Watch history roots, then reconcile only changed paths. Discovery remains a
//! safety net for dropped events, sleep, unsupported filesystems and new roots.
use crate::{
    data::IndexChanged,
    index::{Index, history_folders},
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant, SystemTime},
};

const QUIET: Duration = Duration::from_millis(250);
const MAX_LATENCY: Duration = Duration::from_secs(2);
const RECONCILE: Duration = Duration::from_secs(300);
const FALLBACK: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Batch {
    paths: HashSet<PathBuf>,
    first: Option<Instant>,
    last: Option<Instant>,
    full: bool,
    failed: bool,
}
impl Batch {
    fn push(&mut self, event: notify::Result<Event>, now: Instant) {
        if let Ok(event) = &event
            && matches!(event.kind, EventKind::Access(_))
        {
            return;
        }
        self.first.get_or_insert(now);
        self.last = Some(now);
        match event {
            Ok(event) if !event.need_rescan() && !event.paths.is_empty() => {
                if !self.full {
                    self.paths.extend(event.paths);
                    if self.paths.len() > 1024 {
                        self.full = true;
                        self.paths.clear();
                    }
                }
            }
            Err(_) => {
                self.full = true;
                self.failed = true;
            }
            _ => self.full = true,
        }
    }
    fn ready(&self, now: Instant) -> bool {
        self.full
            || self
                .first
                .is_some_and(|first| now.duration_since(first) >= MAX_LATENCY)
            || self
                .last
                .is_some_and(|last| now.duration_since(last) >= QUIET)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct WatchRoot {
    recursive: bool,
    identity: (u64, u64),
}
type Plan = BTreeMap<PathBuf, WatchRoot>;
fn add_root(plan: &mut Plan, requested: &Path, recursive: bool) {
    let mut path = requested;
    while !path.is_dir() {
        let Some(parent) = path.parent() else { return };
        path = parent;
    }
    let recursive = recursive && path == requested;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        path.metadata()
            .map(|m| (m.dev(), m.ino()))
            .unwrap_or_default()
    };
    #[cfg(not(unix))]
    let identity = (0, 0);
    plan.entry(path.to_path_buf())
        .and_modify(|root| root.recursive |= recursive)
        .or_insert(WatchRoot {
            recursive,
            identity,
        });
}
fn plan(index: &Index) -> crate::error::Result<Plan> {
    let mut plan = Plan::new();
    for source in index.sources()?.into_iter().filter(|s| s.enabled) {
        if source.agent == crate::data::Agent::Antigravity {
            continue;
        }
        let root = Path::new(&source.path);
        // Parent watches survive replacement of the history root itself.
        if let Some(parent) = root.parent() {
            add_root(&mut plan, parent, false);
        }
        add_root(&mut plan, root, false);
        for folder in history_folders(source.agent) {
            add_root(&mut plan, &root.join(folder), true);
        }
    }
    Ok(plan)
}
fn create_watcher(
    plan: &Plan,
    tx: mpsc::SyncSender<notify::Result<Event>>,
    overflow: Arc<AtomicBool>,
) -> notify::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |event| {
        if tx.try_send(event).is_err() {
            overflow.store(true, Ordering::Relaxed);
        }
    })?;
    for (path, root) in plan {
        watcher.watch(
            path,
            if root.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        )?;
    }
    Ok(watcher)
}
fn drain(rx: &Receiver<notify::Result<Event>>, batch: &mut Batch) {
    // Bound each drain so a sustained producer cannot starve the scan.
    for _ in 0..256 {
        let Ok(event) = rx.try_recv() else { break };
        batch.push(event, Instant::now());
    }
}
fn scan(index: &Index, paths: Option<&HashSet<PathBuf>>, emit: &impl Fn(IndexChanged)) {
    let result = match paths {
        Some(paths) => index.scan_paths(paths),
        None => index.scan(),
    };
    match result {
        Ok(changed) => emit(index.take_changes(!changed).unwrap_or_default()),
        Err(error) => {
            eprintln!("Index scan failed: {error}");
            emit(IndexChanged::default());
        }
    }
}

pub fn run(index: Arc<Index>, emit: impl Fn(IndexChanged) + Send + Sync + 'static) {
    let emit = Arc::new(emit);
    let progress = Arc::clone(&emit);
    if let Err(error) = index.set_progress_handler(Arc::new(move || {
        progress(IndexChanged {
            sessions: Some(vec![]),
            progress: true,
        })
    })) {
        eprintln!("Index progress unavailable: {error}");
    }
    let (tx, rx) = mpsc::sync_channel(256);
    let overflow = Arc::new(AtomicBool::new(false));
    let mut roots = Plan::new();
    let mut watcher = None;
    let mut batch = Batch::default();
    let mut last_plan = Instant::now() - FALLBACK;
    let mut last_attempt = Instant::now() - FALLBACK;
    let mut last_scan = Instant::now();
    let mut last_wall = SystemTime::now();
    let mut initial = true;
    loop {
        let now = Instant::now();
        let wall = SystemTime::now();
        let resumed = wall.duration_since(last_wall).unwrap_or_default() > FALLBACK;
        let mut changed_plan = false;
        if initial || resumed || last_plan.elapsed() >= Duration::from_secs(1) {
            last_plan = now;
            match plan(&index) {
                Ok(next) => {
                    changed_plan = next != roots;
                    if initial
                        || changed_plan
                        || resumed
                        || (watcher.is_none() && last_attempt.elapsed() >= FALLBACK)
                    {
                        last_attempt = now;
                        // Register the new plan before discovery. The previous watcher
                        // stays alive until its replacement has been constructed.
                        let next_watcher = create_watcher(&next, tx.clone(), Arc::clone(&overflow));
                        watcher = match next_watcher {
                            Ok(watcher) => Some(watcher),
                            Err(error) => {
                                eprintln!(
                                    "History watching unavailable; reconciling every 30 seconds: {error}"
                                );
                                None
                            }
                        };
                        roots = next;
                    }
                }
                Err(error) => {
                    eprintln!("History watch configuration unavailable: {error}");
                    watcher = None;
                }
            }
        }
        drain(&rx, &mut batch);
        if batch.failed {
            watcher = None;
            last_attempt = now;
        }
        batch.full |= overflow.swap(false, Ordering::Relaxed);
        let periodic = last_scan.elapsed()
            >= if watcher.is_some() {
                RECONCILE
            } else {
                FALLBACK
            };
        if initial || resumed || changed_plan || periodic || batch.ready(Instant::now()) {
            let full = initial || resumed || changed_plan || periodic || batch.full;
            let pending = std::mem::take(&mut batch);
            scan(
                &index,
                if full { None } else { Some(&pending.paths) },
                &*emit,
            );
            if full {
                last_scan = Instant::now();
            }
            initial = false;
        }
        last_wall = SystemTime::now();
        if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
            batch.push(event, Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debounce_has_a_maximum_delay_and_bounds_overflow() {
        let start = Instant::now();
        let mut batch = Batch::default();
        for n in 0..20 {
            let now = start + Duration::from_millis(n * 100);
            batch.push(
                Ok(Event::new(EventKind::Any).add_path(PathBuf::from(format!("/{n}")))),
                now,
            );
            assert!(!batch.ready(now));
        }
        assert!(batch.ready(start + MAX_LATENCY));
        assert_eq!(batch.paths.len(), 20);
        assert!(batch.ready(start + Duration::from_millis(2150)));
        for n in 20..1030 {
            batch.push(
                Ok(Event::new(EventKind::Any).add_path(PathBuf::from(format!("/{n}")))),
                start,
            );
        }
        assert!(batch.full);
        assert!(batch.paths.is_empty());
    }
    #[test]
    fn errors_and_rescan_flags_reconcile_reads_do_not() {
        let mut batch = Batch::default();
        let now = Instant::now();
        batch.push(
            Ok(Event::new(EventKind::Access(
                notify::event::AccessKind::Any,
            ))),
            now,
        );
        assert!(!batch.ready(now + RECONCILE));
        batch.push(
            Ok(Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan)),
            now,
        );
        assert!(batch.full);
        let mut batch = Batch::default();
        batch.push(Err(notify::Error::generic("lost events")), now);
        assert!(batch.full);
    }
    #[test]
    fn native_watcher_reports_history_writes() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let mut roots = Plan::new();
        add_root(&mut roots, root.path(), true);
        let (tx, rx) = mpsc::sync_channel(256);
        let _watcher = create_watcher(&roots, tx, Arc::new(AtomicBool::new(false)))?;
        let file = root.path().join("session.jsonl");
        std::fs::write(&file, "{}\n")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))??;
            if !matches!(event.kind, EventKind::Access(_))
                && event
                    .paths
                    .iter()
                    .any(|path| path.ends_with("session.jsonl"))
            {
                break;
            }
        }
        Ok(())
    }
    #[test]
    fn missing_and_replaced_roots_change_registration() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let history = root.path().join("new/history");
        let mut before = Plan::new();
        add_root(&mut before, &history, true);
        assert!(!before[root.path()].recursive);
        std::fs::create_dir_all(&history)?;
        let mut created = Plan::new();
        add_root(&mut created, &history, true);
        assert!(created[&history].recursive);
        std::fs::rename(&history, root.path().join("old"))?;
        std::fs::create_dir(&history)?;
        let mut replaced = Plan::new();
        add_root(&mut replaced, &history, true);
        #[cfg(unix)]
        assert_ne!(created, replaced);
        Ok(())
    }
}
