//! Keeping the index current, and reading what it points to.
//!
//! A scan stats every source file, parses only those whose modification time
//! or size moved since the last scan, and writes what they say, so an
//! unchanged corpus costs a directory walk. Parsing runs on every core;
//! writing runs on one thread, because SQLite has a single writer and the
//! work is in the parsing.
//!
//! Searching what was said in every conversation reads the agents' files the
//! same way, since the index keeps no conversation's text.

use std::collections::BTreeSet;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::session::{
    Account, Agent, Filter, Limit, Mark, Mention, Provider, Searched, Status, Transcript,
};
use crate::source::{self, Unit};
use crate::store::{Origin, Store};

/// How often a long scan reports how far it has got.
///
/// Often enough that the window fills in as files are read, and long enough
/// that the everyday rescan, which reads a handful of files, finishes before
/// it would report and so never shows progress.
const PROGRESS: Duration = Duration::from_millis(250);

/// How often a search hands over what it has found so far.
const FOUND: Duration = Duration::from_millis(100);

/// The most sessions a search answers with. It looks through the newest first,
/// so these are the most recent.
const MOST: usize = 200;

/// The most problems a scan reports, so a corpus of unreadable files does not
/// fill the interface.
const PROBLEMS: usize = 20;

/// The index and the machinery that keeps it current.
///
/// Scans are not guarded against overlapping: the app's one background thread
/// is the only caller of [`Index::scan`]. Where two locks are held at once,
/// `open` is taken before `store`.
pub struct Index {
    store: Mutex<Store>,
    /// Where the agents' directories live. Overridable so tests never read a
    /// real agent's home.
    home: PathBuf,
    /// What the engine knows so far, for the status command.
    status: Mutex<Status>,
    /// The conversation most recently read, so paging through it is free.
    open: Mutex<Option<Held>>,
    /// The sessions the last scan read anything new of.
    changed: Mutex<BTreeSet<String>>,
    /// Counts searches begun and stopped, so a running search sees it has been
    /// overtaken and stops.
    searches: AtomicU64,
}

/// A conversation held after its first read, and the file it was read from.
struct Held {
    id: String,
    path: PathBuf,
    transcript: Transcript,
}

impl Index {
    /// Open the index in `data_dir`, reading the agents' history under `home`.
    pub fn open(data_dir: &Path, home: PathBuf) -> Result<Index> {
        std::fs::create_dir_all(data_dir).map_err(|source| Error::Write {
            path: data_dir.display().to_string(),
            source,
        })?;
        let store = Store::open(&file(data_dir))?;
        let mut accounts = store.accounts()?;
        order(&mut accounts);
        let status = Status {
            sessions: store.count()?,
            accounts,
            ..Status::default()
        };
        Ok(Index {
            store: Mutex::new(store),
            home,
            status: Mutex::new(status),
            open: Mutex::new(None),
            changed: Mutex::new(BTreeSet::new()),
            searches: AtomicU64::new(0),
        })
    }

    /// Borrow the store for a read.
    pub fn read<T>(&self, action: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        action(&lock(&self.store))
    }

    /// Borrow the store for a write.
    pub(crate) fn write<T>(&self, action: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        action(&mut lock(&self.store))
    }

    /// What the engine knows so far.
    pub(crate) fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    /// Note a change to the reported status.
    fn mark(&self, change: impl FnOnce(&mut Status)) {
        change(&mut lock(&self.status));
    }

    /// Bring the index up to date with what is on disk.
    ///
    /// A long scan hands `report` its status as it goes, so the window can show
    /// sessions as their files are read rather than all at once at the end.
    pub fn scan(&self, report: impl Fn(&Status)) -> Result<Status> {
        self.mark(|status| status.scanning = true);
        let outcome = self.run(&report).and_then(|()| self.note_use());
        // Cleared before the status is answered, so a caller is never told a
        // scan is running when it has finished.
        self.mark(|status| {
            status.scanning = false;
            status.progress = None;
        });
        outcome.map(|()| self.status())
    }

    /// One pass over every agent's history.
    fn run(&self, report: &impl Fn(&Status)) -> Result<()> {
        let agents = source::present(&self.home);
        let units: Vec<Unit> = agents
            .iter()
            .flat_map(|(agent, root)| source::discover(*agent, root))
            .collect();

        // A unit is read again when its modification time or size moved: some
        // agents rewrite a file in place. What is left of what the index knew
        // is no longer on disk.
        let mut known = self.read(Store::signatures)?;
        let mut changed: Vec<&Unit> = units
            .iter()
            .filter(|unit| {
                known.remove(unit.path.to_string_lossy().as_ref()) != Some((unit.mtime, unit.size))
            })
            .collect();
        // Newest first: what someone is most likely to look for appears first,
        // and older history then lands below it in the list rather than above.
        changed.sort_by_key(|unit| std::cmp::Reverse(unit.mtime));

        lock(&self.changed).clear();
        self.mark(|status| {
            status.files_read = changed.len() as i64;
            status.agents = agents.iter().map(|(agent, _)| *agent).collect();
            status.problems.clear();
        });
        let problems = self.absorb(&changed, report);
        self.release_if_stale(&changed)?;
        if !known.is_empty() {
            let gone: Vec<String> = known.into_keys().collect();
            self.write(|store| store.retire(&gone))?;
        }

        let sessions = self.read(Store::count)?;
        self.mark(|status| {
            status.sessions = sessions;
            status.problems = problems;
        });
        Ok(())
    }

    /// Parse every changed unit on every core, writing each as soon as it is
    /// read, and answer the problems met on the way.
    ///
    /// A unit that cannot be read is reported and skipped: one unreadable file
    /// must not cost the whole scan. `report` hears how far the scan has got
    /// every [`PROGRESS`].
    fn absorb(&self, changed: &[&Unit], report: &impl Fn(&Status)) -> Vec<String> {
        let total = changed.len() as i64;
        let mut problems = fan_out(
            changed,
            |unit| Some((*unit, source::summarize(unit))),
            || false,
            |summarized| {
                let mut problems = Vec::new();
                let mut reported = Instant::now();
                for (done, (unit, read)) in (1..).zip(summarized) {
                    let written = read.and_then(|summaries| {
                        self.write(|store| store.put(unit, &summaries))?;
                        Ok(summaries)
                    });
                    match written {
                        Ok(summaries) => lock(&self.changed)
                            .extend(summaries.into_iter().map(|summary| summary.session.id)),
                        Err(error) => problems.push(error.to_string()),
                    }
                    if reported.elapsed() >= PROGRESS {
                        self.mark(|status| status.progress = Some((done, total)));
                        report(&self.status());
                        reported = Instant::now();
                    }
                }
                problems
            },
        );
        problems.sort();
        problems.dedup();
        problems.truncate(PROBLEMS);
        problems
    }

    /// Note when each subscription was last used by a session on this machine.
    ///
    /// Usage is dated to the quarter hour, so the end of the latest one stands
    /// in for when it happened, and never later than now.
    fn note_use(&self) -> Result<()> {
        let used = self.read(Store::last_used)?;
        let now = crate::timestamp::now();
        self.mark(|status| {
            for account in &mut status.accounts {
                account.used_at = last_used(account, &used, now);
            }
        });
        Ok(())
    }

    /// The sessions the last scan read anything new of, each once, so a window
    /// showing one can read it again without asking about the rest.
    pub(crate) fn changed(&self) -> Vec<String> {
        lock(&self.changed).iter().cloned().collect()
    }

    /// A window of one session's conversation.
    ///
    /// The whole conversation is parsed on the first request and held, so
    /// scrolling through a long session costs one read rather than one per
    /// page. Only the most recent is kept: someone reads one conversation at a
    /// time, and the largest on this machine holds fifty megabytes of tool
    /// output.
    pub fn transcript(&self, id: &str, offset: i64, limit: i64) -> Result<Transcript> {
        self.held(id, |transcript| transcript.window(offset, limit))
    }

    /// Where every turn of a session's conversation falls, for its timeline.
    pub(crate) fn timeline(&self, id: &str) -> Result<Vec<Mark>> {
        self.held(id, Transcript::marks)
    }

    /// The turns of a session's conversation that contain `query`, ignoring
    /// case, as [`Transcript::find`] finds them.
    pub(crate) fn find(&self, id: &str, query: &str) -> Result<Vec<i64>> {
        self.held(id, |transcript| transcript.find(query))
    }

    /// Read from a session's whole conversation, parsing it unless it is the
    /// one already held.
    ///
    /// The lock is kept for the whole read, so a second request for a session
    /// still being parsed waits for that parse instead of starting another.
    /// The counts of messages and tool calls are a by-product of the parse, so
    /// they are stored rather than being a reason to read the file again.
    fn held<T>(&self, id: &str, read: impl FnOnce(&Transcript) -> T) -> Result<T> {
        let mut open = lock(&self.open);
        if let Some(held) = open.as_ref()
            && held.id == id
        {
            return Ok(read(&held.transcript));
        }

        let (unit, native_id) = self
            .read(|store| store.locate(id))?
            .ok_or_else(|| Error::NotFound(format!("session {id}")))?;
        let transcript = source::transcript(&unit, &native_id)?;
        self.write(|store| store.put_counts(id, transcript.messages, transcript.tools))?;
        let held = open.insert(Held {
            id: id.to_owned(),
            path: unit.path,
            transcript,
        });
        Ok(read(&held.transcript))
    }

    /// Forget the held conversation if a scan changed what it was read from:
    /// its file was rewritten, or its session has moved on to a newer file, as
    /// a resumed Codex thread does.
    ///
    /// Agents write every few seconds while they work, so releasing it on any
    /// change would parse a long conversation again for nearly every page read
    /// from it. A file that has gone leaves it held: what was read is still
    /// that session's history, and there is nothing newer to read.
    fn release_if_stale(&self, changed: &[&Unit]) -> Result<()> {
        if changed.is_empty() {
            return Ok(());
        }
        let mut open = lock(&self.open);
        let Some(held) = open.as_ref() else {
            return Ok(());
        };
        let stale = changed.iter().any(|unit| unit.path == held.path)
            || self
                .read(|store| store.locate(&held.id))?
                .is_none_or(|(unit, _)| unit.path != held.path);
        if stale {
            *open = None;
        }
        Ok(())
    }

    /// Look through what was said in the conversation of every session a
    /// filter matches, newest first, for `query`, ignoring case, handing
    /// `found` each batch of sessions that mention it as they turn up.
    ///
    /// The search runs as [`look_through`] describes, and also ends when a
    /// later search or [`Index::stop_searching`] overtakes it.
    pub fn search(
        &self,
        query: &str,
        filter: &Filter,
        found: impl Fn(Vec<Mention>) -> bool,
    ) -> Result<Searched> {
        let search = self.searches.fetch_add(1, Ordering::SeqCst) + 1;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Searched::default());
        }
        let origins = self.read(|store| store.origins(filter))?;
        Ok(look_through(
            &origins,
            &self.home,
            &needle,
            || self.searches.load(Ordering::Relaxed) != search,
            found,
        ))
    }

    /// Stop any search that is running.
    pub(crate) fn stop_searching(&self) {
        self.searches.fetch_add(1, Ordering::SeqCst);
    }

    /// Forget the held conversation, so its memory is returned.
    pub fn close(&self) {
        *lock(&self.open) = None;
    }

    /// Agents present on this machine, with where their history lives.
    pub(crate) fn agents(&self) -> Vec<(Agent, PathBuf)> {
        source::present(&self.home)
    }

    /// Record the latest read of one subscription's accounts.
    ///
    /// An account whose read failed keeps the limits last read successfully,
    /// with the reason they were not refreshed. An account no app holds a
    /// sign-in to any more is dropped. An account whose limits rose since a
    /// read shortly before is in use. What was read is kept for the next
    /// launch.
    pub(crate) fn record(&self, provider: Provider, mut accounts: Vec<Account>) -> Result<()> {
        self.mark(|status| {
            for account in &mut accounts {
                let Some(known) = status.accounts.iter().find(|known| known.id == account.id)
                else {
                    continue;
                };
                account.used_at = known.used_at;
                if account.read_at.is_some() {
                    if rose(known, account) {
                        account.used_at = account.read_at;
                    }
                } else {
                    account.plan = account.plan.take().or_else(|| known.plan.clone());
                    // Limits that could not be refreshed have no current pace.
                    account.limits = known
                        .limits
                        .iter()
                        .map(|limit| Limit {
                            runs_out_at: None,
                            per_hour: None,
                            ..limit.clone()
                        })
                        .collect();
                    account.read_at = known.read_at;
                }
            }
            status.accounts.retain(|known| known.provider != provider);
            status.accounts.extend(accounts.iter().cloned());
            order(&mut status.accounts);
        });
        self.write(|store| store.put_accounts(provider, &accounts))
    }
}

/// Look through the conversations of `origins` under `home`, newest first, for
/// `needle`, which is lowercase and not empty, handing `found` each batch of
/// sessions that mention it as they turn up, and answer how far it got.
///
/// Conversations are read from the agents' files, on every core, and one
/// whose files cannot contain the needle is passed over unread, as is one
/// that cannot be read. The search ends when it has looked through them all,
/// when it has found [`MOST`], when `overtaken` says so, or when `found`
/// answers that nobody is listening any more.
pub(crate) fn look_through(
    origins: &[Origin],
    home: &Path,
    needle: &str,
    overtaken: impl Fn() -> bool + Sync,
    found: impl Fn(Vec<Mention>) -> bool,
) -> Searched {
    let library = source::Library::new(home, needle);
    let searched = AtomicUsize::new(0);
    let done = AtomicBool::new(false);

    let capped = fan_out(
        origins,
        |Origin { session, unit }| {
            let mentioned = library
                .may_mention(unit, &session.native_id)
                .then(|| library.transcript(unit, &session.native_id).ok())
                .flatten()
                .and_then(|transcript| transcript.mentions(needle));
            searched.fetch_add(1, Ordering::Relaxed);
            mentioned.map(|mentioned| Mention {
                session: session.clone(),
                turns: mentioned.turns,
                first: mentioned.first,
                excerpt: mentioned.excerpt,
            })
        },
        || done.load(Ordering::Relaxed) || overtaken(),
        |mentions| {
            // Handed over together every so often rather than one message
            // each, and never past the most a search answers with.
            let mut batch = Vec::new();
            let mut handed = 0;
            let mut last = Instant::now();
            loop {
                let ended = match mentions.recv_timeout(FOUND) {
                    Ok(mention) => {
                        batch.push(mention);
                        false
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => false,
                    Err(mpsc::RecvTimeoutError::Disconnected) => true,
                };
                let capped = handed + batch.len() >= MOST;
                batch.truncate(MOST - handed);
                if !batch.is_empty() && (ended || capped || last.elapsed() >= FOUND) {
                    handed += batch.len();
                    if !found(std::mem::take(&mut batch)) {
                        done.store(true, Ordering::Relaxed);
                    }
                    last = Instant::now();
                }
                if ended || capped {
                    done.store(true, Ordering::Relaxed);
                    return capped;
                }
            }
        },
    );
    Searched {
        searched: searched.into_inner() as i64,
        total: origins.len() as i64,
        capped,
    }
}

/// Where the index is kept in the application's data directory.
pub(crate) fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("index.sqlite")
}

/// When an account was last in use: as it was last seen, by a session on this
/// machine using its subscription, going by the provider `used` names, or by
/// its limits rising, and never later than `now`.
pub(crate) fn last_used(account: &Account, used: &[(String, i64)], now: i64) -> Option<i64> {
    let local = used
        .iter()
        .filter(|(provider, _)| Provider::serving(provider) == Some(account.provider))
        .map(|&(_, at)| at.min(now))
        .max();
    account.used_at.max(local)
}

/// The file whose lock says the index beside it is being kept current.
fn keeper_file(data_dir: &Path) -> PathBuf {
    data_dir.join("keeper.lock")
}

/// A mark that this process keeps the index current, held for as long as the
/// process runs: an exclusive lock on a file beside the index, which the
/// system releases when the process ends, however it ends.
pub(crate) struct Keeper {
    /// Held only to keep the lock.
    _locked: std::fs::File,
}

impl Keeper {
    /// Mark the index in `data_dir` as kept current by this process, waiting
    /// while another process holds the mark: a server checking it holds it for
    /// a moment, and another copy of the app for as long as that copy runs.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be opened or locked.
    pub(crate) fn claim(data_dir: &Path) -> std::io::Result<Keeper> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(keeper_file(data_dir))?;
        file.lock()?;
        Ok(Keeper { _locked: file })
    }
}

/// Whether a running app keeps the index in `data_dir` current.
///
/// # Errors
///
/// Returns an error when the mark cannot be checked. No mark at all means no
/// app has run.
pub(crate) fn kept(data_dir: &Path) -> std::io::Result<bool> {
    let file = match std::fs::File::open(keeper_file(data_dir)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    // A shared lock taken here is released as the file closes.
    match file.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Lock a mutex, recovering it from a thread that panicked while holding it.
///
/// Nothing guarded here is left half-made by a panic that matters: a store
/// transaction rolls back when dropped, and the rest is replaced whole by the
/// next scan, read or record.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Run `work` on each item on every core, and hand what it answers to `take`
/// on this thread as it arrives, answering what `take` does.
///
/// A worker stops taking items once `stop` says so, or once `take` has
/// returned and dropped the channel; the channel closes when every worker has
/// finished.
fn fan_out<'a, T: Sync, R: Send, A>(
    items: &'a [T],
    work: impl Fn(&'a T) -> Option<R> + Sync,
    stop: impl Fn() -> bool + Sync,
    take: impl FnOnce(mpsc::Receiver<R>) -> A,
) -> A {
    let workers = std::thread::available_parallelism()
        .map_or(4, NonZeroUsize::get)
        .min(items.len());
    let next = AtomicUsize::new(0);
    let (send, receive) = mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let (send, next, work, stop) = (send.clone(), &next, &work, &stop);
            scope.spawn(move || {
                while !stop() {
                    let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) else {
                        break;
                    };
                    if let Some(result) = work(item)
                        && send.send(result).is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(send);
        take(receive)
    })
}

/// Put accounts in the order the interface lists them.
fn order(accounts: &mut [Account]) {
    accounts.sort_by(|a, b| (a.provider, &a.id).cmp(&(b.provider, &b.id)));
}

/// Whether any limit went up between two reads close enough together to say
/// the account is in use now, from this machine or any other.
fn rose(before: &Account, after: &Account) -> bool {
    let close = matches!(
        (before.read_at, after.read_at),
        (Some(then), Some(now)) if now - then <= Account::IN_USE
    );
    close
        && after.limits.iter().any(|limit| {
            before.limits.iter().any(|was| {
                was.name == limit.name
                    && was.scope == limit.scope
                    && limit.used_percent > was.used_percent
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    use crate::session::Problem;

    /// A home directory holding one Claude Code session.
    fn home() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temp dir");
        let projects = directory.path().join(".claude/projects/-w-proj");
        std::fs::create_dir_all(&projects).expect("creates");
        write_session(&projects.join("abc.jsonl"), "abc", "First prompt", 500);
        directory
    }

    /// A Claude Code session of one prompt and one reply that used `tokens`.
    fn write_session(path: &Path, id: &str, prompt: &str, tokens: i64) {
        // A format string built by `concat!` cannot capture names inline.
        let contents = format!(
            concat!(
                r#"{{"type":"user","message":{{"role":"user","content":"{prompt}"}},"timestamp":"2026-09-11T23:38:22.696Z","cwd":"/w/proj","sessionId":"{id}"}}"#,
                "\n",
                r#"{{"type":"assistant","message":{{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[],"usage":{{"input_tokens":{tokens}}}}},"requestId":"req_1","timestamp":"2026-09-11T23:38:30.000Z","sessionId":"{id}"}}"#,
                "\n",
            ),
            prompt = prompt,
            id = id,
            tokens = tokens
        );
        std::fs::write(path, contents).expect("writes");
    }

    fn index(home: &tempfile::TempDir) -> Index {
        let data = home.path().join("data");
        Index::open(&data, home.path().to_path_buf()).expect("opens")
    }

    #[test]
    fn a_scan_finds_and_indexes_a_session() {
        let home = home();
        let index = index(&home);
        // A scan this small finishes before its first report is due, so it
        // never shows progress.
        let reports = std::cell::Cell::new(0);
        let status = index
            .scan(|_| reports.set(reports.get() + 1))
            .expect("scans");
        assert_eq!(reports.get(), 0);
        assert_eq!(status.progress, None);

        assert_eq!(status.files_read, 1);
        assert_eq!(status.sessions, 1);
        assert!(status.problems.is_empty());
        assert!(!status.scanning);
        assert_eq!(status.agents, [Agent::ClaudeCode]);

        let found = index
            .read(|store| store.get("claude_code:abc"))
            .expect("reads")
            .expect("exists");
        assert_eq!(found.title.as_deref(), Some("First prompt"));
        assert_eq!(found.tokens.total, 500);
        // 500 input tokens at Opus's $5 per million.
        assert_eq!(found.cost_usd, Some(0.0025));
    }

    #[test]
    fn a_changed_file_is_read_again() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("first scan");

        let path = home.path().join(".claude/projects/-w-proj/abc.jsonl");
        // A new size is enough of a signal; the modification time may not have
        // a fine enough resolution to differ within one test.
        write_session(&path, "abc", "A much longer replacement prompt", 900);

        let second = index.scan(|_| {}).expect("second scan");
        assert_eq!(second.files_read, 1);
        let found = index
            .read(|store| store.get("claude_code:abc"))
            .expect("reads")
            .expect("exists");
        assert_eq!(found.tokens.total, 900);
        assert_eq!(
            found.title.as_deref(),
            Some("A much longer replacement prompt")
        );
    }

    #[test]
    fn a_deleted_file_leaves_its_history_marked_absent() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("first scan");
        std::fs::remove_file(home.path().join(".claude/projects/-w-proj/abc.jsonl"))
            .expect("removes");

        let second = index.scan(|_| {}).expect("second scan");
        assert_eq!(second.sessions, 1, "the session is kept");

        let found = index
            .read(|store| store.get("claude_code:abc"))
            .expect("reads")
            .expect("still indexed");
        assert!(!found.present, "but it is flagged as gone from its source");
    }

    #[test]
    fn many_files_are_all_indexed() {
        let home = tempfile::tempdir().expect("temp dir");
        let projects = home.path().join(".claude/projects/-w-proj");
        std::fs::create_dir_all(&projects).expect("creates");
        for index in 0..50 {
            write_session(
                &projects.join(format!("s{index}.jsonl")),
                &format!("s{index}"),
                "Prompt",
                index,
            );
        }

        let index = index(&home);
        let status = index.scan(|_| {}).expect("scans");
        assert_eq!(status.files_read, 50, "parallel work must not drop units");
        assert_eq!(status.sessions, 50);
    }

    #[test]
    fn a_model_reached_through_two_providers_is_one_model() {
        let home = tempfile::tempdir().expect("temp dir");
        let sessions = home.path().join(".pi/agent/sessions");
        std::fs::create_dir_all(&sessions).expect("creates");
        // Pi records the model as each provider takes it: with its vendor
        // through OpenRouter, and bare from Google itself.
        for (id, provider, model) in [
            ("routed", "openrouter", "google/gemini-3.8-flash"),
            ("direct", "google", "gemini-3.8-flash"),
        ] {
            let contents = format!(
                concat!(
                    r#"{{"type":"session","id":"{id}","timestamp":"2026-09-06T08:09:52.606Z","cwd":"/w/proj"}}"#,
                    "\n",
                    r#"{{"type":"model_change","timestamp":"2026-09-06T08:09:52.635Z","provider":"{provider}","modelId":"{model}"}}"#,
                    "\n",
                    r#"{{"type":"message","timestamp":"2026-09-06T08:10:01.067Z","message":{{"role":"assistant","content":[],"usage":{{"input":100,"output":10,"totalTokens":110}}}}}}"#,
                    "\n",
                ),
                id = id,
                provider = provider,
                model = model
            );
            std::fs::write(sessions.join(format!("{id}.jsonl")), contents).expect("writes");
        }

        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let models = index.read(|store| store.models(None, None)).expect("ranks");
        let ranked: Vec<_> = models
            .iter()
            .map(|model| (model.model.as_str(), model.sessions))
            .collect();
        assert_eq!(ranked, [("gemini-3.8-flash", 2)]);

        // The model's row opens its sessions by that name, and finds both.
        let filter = Filter {
            model: Some("gemini-3.8-flash".into()),
            limit: 50,
            ..Filter::default()
        };
        let using = index.read(|store| store.list(&filter)).expect("lists");
        assert_eq!(using.total, 2);
    }

    #[test]
    fn an_unreadable_unit_is_reported_without_stopping_the_scan() {
        let home = home();
        let projects = home.path().join(".claude/projects/-w-proj");
        let unreadable = projects.join("broken.jsonl");
        write_session(&unreadable, "broken", "Prompt", 1);
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000))
            .expect("removes read permission");

        let index = index(&home);
        let status = index.scan(|_| {}).expect("scans");
        assert_eq!(status.sessions, 1, "the good session is still indexed");
        assert_eq!(status.problems.len(), 1);
        assert!(status.problems[0].contains("broken.jsonl"));
    }

    #[test]
    fn an_empty_home_scans_cleanly() {
        let home = tempfile::tempdir().expect("temp dir");
        let index = index(&home);
        let status = index.scan(|_| {}).expect("scans");
        assert_eq!(status.files_read, 0);
        assert_eq!(status.sessions, 0);
        assert!(status.agents.is_empty());
        assert!(status.problems.is_empty());
    }

    #[test]
    fn reading_a_transcript_records_its_counts() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let before = index
            .read(|store| store.get("claude_code:abc"))
            .expect("reads")
            .expect("exists");
        assert_eq!(before.messages, None, "not known until the file is read");

        let transcript = index.transcript("claude_code:abc", 0, 100).expect("reads");
        assert_eq!(transcript.session_id, "claude_code:abc");
        assert_eq!(transcript.messages, 1);
        assert_eq!(transcript.total, transcript.turns.len() as i64);

        let after = index
            .read(|store| store.get("claude_code:abc"))
            .expect("reads")
            .expect("exists");
        assert_eq!(after.messages, Some(1), "learned by reading, then kept");
        assert_eq!(after.tools, Some(0));
    }

    #[test]
    fn a_timeline_marks_every_turn_of_the_conversation() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let marks = index.timeline("claude_code:abc").expect("reads");
        let transcript = index
            .transcript("claude_code:abc", 0, 2_000)
            .expect("reads");
        assert_eq!(marks.len() as i64, transcript.total);
        let speakers: Vec<_> = marks.iter().map(|mark| mark.speaker).collect();
        let spoken: Vec<_> = transcript.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(speakers, spoken);
    }

    #[test]
    fn a_transcript_pages_without_losing_the_total() {
        let home = tempfile::tempdir().expect("temp dir");
        let projects = home.path().join(".claude/projects/-w-proj");
        std::fs::create_dir_all(&projects).expect("creates");
        let lines: String = (0..25)
            .map(|turn| {
                format!(
                    concat!(
                        r#"{{"type":"user","message":{{"role":"user","content":"Prompt {turn}"}},"#,
                        r#""timestamp":"2026-09-11T23:38:22.696Z","sessionId":"paged"}}"#,
                        "\n"
                    ),
                    turn = turn
                )
            })
            .collect();
        std::fs::write(projects.join("paged.jsonl"), lines).expect("writes");

        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let first = index.transcript("claude_code:paged", 0, 10).expect("reads");
        assert_eq!(first.turns.len(), 10, "the window is honoured");
        assert_eq!(first.total, 25, "but the total is the whole session");
        assert_eq!(first.turns[0].text, "Prompt 0");

        let second = index
            .transcript("claude_code:paged", 20, 10)
            .expect("reads");
        let texts: Vec<_> = second.turns.iter().map(|turn| turn.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Prompt 20",
                "Prompt 21",
                "Prompt 22",
                "Prompt 23",
                "Prompt 24"
            ]
        );
        assert_eq!(second.total, 25);
    }

    #[test]
    fn a_rescan_releases_a_held_conversation() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");
        index.transcript("claude_code:abc", 0, 10).expect("reads");

        // The held copy must not outlive a change to the file it came from.
        write_session(
            &home.path().join(".claude/projects/-w-proj/abc.jsonl"),
            "abc",
            "A completely different and longer opening prompt",
            900,
        );
        index.scan(|_| {}).expect("rescans");

        let again = index.transcript("claude_code:abc", 0, 10).expect("reads");
        assert_eq!(
            again.turns[0].text,
            "A completely different and longer opening prompt"
        );
    }

    #[test]
    fn a_rescan_of_other_files_keeps_a_held_conversation() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");
        index.transcript("claude_code:abc", 0, 10).expect("reads");

        let projects = home.path().join(".claude/projects/-w-proj");
        write_session(&projects.join("other.jsonl"), "other", "Elsewhere", 100);
        let rescan = index.scan(|_| {}).expect("rescans");
        assert_eq!(rescan.files_read, 1, "only the other session's file");

        // Rewritten after the scan, so reading the file again would show this
        // prompt; seeing the first one shows the held copy was kept.
        write_session(&projects.join("abc.jsonl"), "abc", "Not yet scanned", 500);
        let kept = index.transcript("claude_code:abc", 0, 10).expect("reads");
        assert_eq!(kept.turns[0].text, "First prompt");
    }

    #[test]
    fn a_scan_names_the_sessions_it_read_anything_new_of() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");
        assert_eq!(index.changed(), ["claude_code:abc"]);

        index.scan(|_| {}).expect("rescans");
        assert!(index.changed().is_empty(), "nothing moved");

        let projects = home.path().join(".claude/projects/-w-proj");
        write_session(&projects.join("other.jsonl"), "other", "Elsewhere", 100);
        index.scan(|_| {}).expect("rescans");
        assert_eq!(index.changed(), ["claude_code:other"], "only what moved");

        // One session carried on in a second file is named once.
        write_session(
            &projects.join("abc.jsonl"),
            "abc",
            "First prompt, again",
            500,
        );
        write_session(&projects.join("resumed.jsonl"), "abc", "Carried on", 700);
        index.scan(|_| {}).expect("rescans");
        assert_eq!(index.changed(), ["claude_code:abc"]);
    }

    /// Search, and gather every mention handed over, in any order.
    fn search(index: &Index, query: &str, filter: &Filter) -> (Vec<Mention>, Searched) {
        let found = std::cell::RefCell::new(Vec::new());
        let searched = index
            .search(query, filter, |batch| {
                found.borrow_mut().extend(batch);
                true
            })
            .expect("searches");
        let mut found = found.into_inner();
        found.sort_by(|a, b| a.session.id.cmp(&b.session.id));
        (found, searched)
    }

    #[test]
    fn a_search_finds_the_conversations_that_say_it() {
        let home = home();
        let projects = home.path().join(".claude/projects/-w-proj");
        write_session(
            &projects.join("keys.jsonl"),
            "keys",
            "Add IDEMPOTENCY keys",
            100,
        );
        write_session(
            &projects.join("quiet.jsonl"),
            "quiet",
            "Nothing to see here",
            100,
        );
        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let (found, searched) = search(&index, "  idempotency ", &Filter::default());
        let ids: Vec<_> = found
            .iter()
            .map(|mention| mention.session.id.as_str())
            .collect();
        assert_eq!(ids, ["claude_code:keys"]);
        assert_eq!(found[0].turns, 1);
        assert_eq!(found[0].first, 0);
        assert_eq!(found[0].excerpt, "Add IDEMPOTENCY keys");
        assert_eq!(
            found[0].session.title.as_deref(),
            Some("Add IDEMPOTENCY keys")
        );
        assert_eq!(
            searched,
            Searched {
                searched: 3,
                total: 3,
                capped: false,
            }
        );

        // A filter narrows what is looked through, as it narrows the list.
        let codex = Filter {
            agents: vec![Agent::Codex],
            ..Filter::default()
        };
        assert_eq!(search(&index, "idempotency", &codex).1.total, 0);
        // Nothing is looked for in nothing.
        assert_eq!(
            search(&index, "   ", &Filter::default()).1,
            Searched::default()
        );
    }

    #[test]
    fn a_search_stops_at_the_most_it_answers_with() {
        let home = home();
        let projects = home.path().join(".claude/projects/-w-proj");
        for session in 0..MOST + 5 {
            let id = format!("s{session}");
            write_session(&projects.join(format!("{id}.jsonl")), &id, "The needle", 10);
        }
        let index = index(&home);
        index.scan(|_| {}).expect("scans");

        let (found, searched) = search(&index, "needle", &Filter::default());
        assert_eq!(found.len(), MOST);
        assert!(searched.capped);
        assert_eq!(
            searched.total,
            MOST as i64 + 6,
            "every session was a candidate"
        );
    }

    #[test]
    fn a_session_moving_to_a_newer_file_releases_a_held_conversation() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");
        index.transcript("claude_code:abc", 0, 10).expect("reads");

        // The same session carried on in a file of its own, as a resumed
        // thread is; the file the held copy came from is untouched.
        let projects = home.path().join(".claude/projects/-w-proj");
        write_session(&projects.join("resumed.jsonl"), "abc", "Carried on", 700);
        index.scan(|_| {}).expect("rescans");

        let moved = index.transcript("claude_code:abc", 0, 10).expect("reads");
        assert_eq!(moved.turns[0].text, "Carried on");
    }

    #[test]
    fn an_unknown_session_has_no_transcript() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("scans");
        let failure = index
            .transcript("claude_code:nope", 0, 100)
            .expect_err("must fail");
        assert!(matches!(failure, crate::error::Error::NotFound(_)));
    }

    #[test]
    fn an_unchanged_corpus_is_not_read_again_even_after_a_relaunch() {
        let home = home();
        let engine = index(&home);
        engine.scan(|_| {}).expect("first scan");
        let second = engine.scan(|_| {}).expect("second scan");
        assert_eq!((second.files_read, second.sessions), (0, 1));

        drop(engine);
        let reopened = index(&home);
        assert_eq!(reopened.status().sessions, 1, "known before any scan");
        let third = reopened.scan(|_| {}).expect("third scan");
        assert_eq!((third.files_read, third.sessions), (0, 1));
    }

    #[test]
    fn a_failed_read_keeps_an_accounts_limits_and_a_signed_out_account_goes() {
        let home = home();
        let engine = index(&home);
        let read = Account {
            id: "codex:a".into(),
            provider: Provider::Codex,
            label: None,
            plan: Some("pro".into()),
            via: vec!["Codex".into()],
            limits: vec![Limit {
                name: "Weekly".into(),
                scope: None,
                used_percent: 40.0,
                resets_at: None,
                starts_at: None,
                runs_out_at: None,
                per_hour: None,
            }],
            read_at: Some(1_000),
            problem: None,
            used_at: None,
        };
        engine
            .record(Provider::Codex, vec![read.clone()])
            .expect("records");

        // The same account, now refused by every app holding it.
        let refused = Account {
            plan: None,
            via: vec!["Codex".into(), "Pi".into()],
            limits: Vec::new(),
            read_at: None,
            problem: Some(Problem::SignIn),
            ..read.clone()
        };
        engine
            .record(Provider::Codex, vec![refused])
            .expect("records");
        let kept = engine.status().accounts;
        assert_eq!(kept[0].limits, read.limits, "the last limits stay");
        assert_eq!(kept[0].plan.as_deref(), Some("pro"));
        assert_eq!(kept[0].via, ["Codex", "Pi"]);
        assert_eq!(kept[0].problem, Some(Problem::SignIn));

        // What was read survives a relaunch.
        drop(engine);
        let reopened = index(&home);
        assert_eq!(reopened.status().accounts[0].limits, read.limits);

        // Signed out of every app: the account goes, here and on disk.
        reopened
            .record(Provider::Codex, Vec::new())
            .expect("records");
        assert!(reopened.status().accounts.is_empty());
        drop(reopened);
        assert!(index(&home).status().accounts.is_empty());
    }

    #[test]
    fn a_subscription_is_in_use_when_a_session_uses_it_or_its_limits_rise() {
        let home = home();
        let engine = index(&home);
        let account = |provider: Provider, used_percent: f64, read_at: i64| Account {
            id: format!("{}:a", provider.key()),
            provider,
            label: None,
            plan: None,
            via: Vec::new(),
            limits: vec![Limit {
                name: "5 hours".into(),
                scope: None,
                used_percent,
                resets_at: None,
                starts_at: None,
                runs_out_at: None,
                per_hour: None,
            }],
            read_at: Some(read_at),
            problem: None,
            used_at: None,
        };
        let used = |provider| {
            engine
                .status()
                .accounts
                .into_iter()
                .find(|account| account.provider == provider)
                .and_then(|account| account.used_at)
        };
        for provider in [Provider::Claude, Provider::Codex] {
            let read = account(provider, 10.0, 0);
            engine.record(provider, vec![read]).expect("records");
        }

        // The Claude Code session used Anthropic's models at 23:38.
        engine.scan(|_| {}).expect("scans");
        let quarter_end = crate::timestamp::from_json(&serde_json::json!("2026-09-11T23:45:00Z"));
        assert_eq!(used(Provider::Claude), quarter_end);
        assert_eq!(used(Provider::Codex), None);

        // Codex's limits rose between reads five minutes apart.
        let rose = account(Provider::Codex, 12.0, 5 * 60_000);
        engine.record(Provider::Codex, vec![rose]).expect("records");
        assert_eq!(used(Provider::Codex), Some(5 * 60_000));

        // Across an hour, a rise says nothing about now, and a read keeps
        // what the scan found.
        let later = account(Provider::Claude, 50.0, 60 * 60_000);
        engine
            .record(Provider::Claude, vec![later])
            .expect("records");
        assert_eq!(used(Provider::Claude), quarter_end);
    }
}
