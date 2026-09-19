//! Building and refreshing the index.
//!
//! A scan does three things: stat every source file, parse only the ones whose
//! modification time or size moved since last time, and write what they say.
//! An unchanged corpus therefore costs a directory walk and nothing else, and
//! a changed one costs only the files that actually changed.
//!
//! Parsing runs on every core. Writing runs on one thread, because SQLite has
//! a single writer and the work is entirely in the parsing anyway.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use crate::error::Result;
use crate::session::{Account, Agent, Limit, Provider, Status, Transcript};
use crate::source::{self, Unit};
use crate::store::Store;

/// How often a long scan reports how far it has got.
///
/// Often enough that the window fills in as files are read, and long enough
/// that the everyday rescan, which reads a handful of files, finishes before it
/// would report and so never shows progress.
const PROGRESS: Duration = Duration::from_millis(250);

/// The index and the machinery that keeps it current.
///
/// Scans are not guarded against overlapping. Callers run them one at a time;
/// while the app is open, its one background thread is the only caller of
/// [`Index::scan`].
pub struct Index {
    store: Mutex<Store>,
    /// Where the agents' directories live. Overridable so tests never read a
    /// real agent's home.
    home: PathBuf,
    /// What the last scan found, for the status command.
    status: Mutex<Status>,
    /// The conversation most recently read, so paging through it is free.
    open: Mutex<Option<Held>>,
    /// The sessions the last scan read anything new of.
    changed: Mutex<Vec<String>>,
}

/// A conversation held after its first read, and where it was read from.
struct Held {
    /// The session it belongs to.
    id: String,
    /// The file it was read from, as the index names it.
    path: String,
    transcript: Transcript,
}

impl Index {
    /// Open the index beside the application's other data.
    pub fn open(data_dir: &Path, home: PathBuf) -> Result<Index> {
        std::fs::create_dir_all(data_dir).map_err(|source| crate::error::Error::Read {
            path: data_dir.display().to_string(),
            source,
        })?;
        let store = Store::open(&data_dir.join("index.sqlite"))?;
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
            changed: Mutex::new(Vec::new()),
        })
    }

    /// Borrow the store for a read.
    pub fn read<T>(&self, action: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        let store = self.store.lock().expect("the index lock is never poisoned");
        action(&store)
    }

    /// Borrow the store for a write.
    pub fn write<T>(&self, action: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut store = self.store.lock().expect("the index lock is never poisoned");
        action(&mut store)
    }

    /// What the engine knows so far.
    pub fn status(&self) -> Status {
        self.status.lock().expect("never poisoned").clone()
    }

    /// Bring the index up to date with what is on disk.
    ///
    /// A long scan hands `report` its status as it goes, so the window can show
    /// sessions as their files are read rather than all at once at the end.
    pub fn scan(&self, report: impl Fn(&Status)) -> Result<Status> {
        self.mark(|status| status.scanning = true);

        let outcome = self.run(&report).and_then(|()| self.note_use());

        self.mark(|status| {
            status.scanning = false;
            status.progress = None;
        });
        // Report the status after clearing the flag, so a caller is never told
        // a scan is still running when it has already finished.
        outcome.map(|()| self.status())
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
                let local = used
                    .iter()
                    .filter(|(provider, _)| Provider::serving(provider) == Some(account.provider))
                    .map(|&(_, at)| at.min(now))
                    .max();
                account.used_at = account.used_at.max(local);
            }
        });
        Ok(())
    }

    /// Note a change to the reported status.
    fn mark(&self, change: impl FnOnce(&mut Status)) {
        change(&mut self.status.lock().expect("never poisoned"));
    }

    /// One pass over every agent's history.
    fn run(&self, report: &impl Fn(&Status)) -> Result<()> {
        let agents = source::present(&self.home);
        let mut units = Vec::new();
        for (agent, root) in &agents {
            units.extend(source::discover(*agent, root));
        }

        let known = self.read(Store::signatures)?;
        // A unit is re-read only when its file actually moved. Modification
        // time alone is not enough: some agents rewrite a file in place.
        let mut changed: Vec<Unit> = units
            .iter()
            .filter(|unit| {
                let path = unit.path.to_string_lossy();
                known.get(path.as_ref()) != Some(&(unit.mtime, unit.size))
            })
            .cloned()
            .collect();
        // Newest first: what someone is most likely to look for appears first,
        // and older history then lands below it in the list rather than above.
        changed.sort_by_key(|unit| std::cmp::Reverse(unit.mtime));

        let files_read = changed.len() as i64;
        self.changed.lock().expect("never poisoned").clear();
        self.mark(|status| {
            status.files_read = files_read;
            status.agents = agents.iter().map(|(agent, _)| *agent).collect();
            status.problems.clear();
        });

        let problems = self.absorb(&changed, report);
        self.release_if_stale(&changed)?;

        // Files the index knows about that are no longer on disk.
        let live: std::collections::HashSet<String> = units
            .iter()
            .map(|unit| unit.path.to_string_lossy().into_owned())
            .collect();
        let gone: Vec<String> = known
            .keys()
            .filter(|path| !live.contains(*path))
            .cloned()
            .collect();
        if !gone.is_empty() {
            self.write(|store| store.retire(&gone))?;
        }

        let sessions = self.read(Store::count)?;
        self.mark(|status| {
            status.sessions = sessions;
            status.problems = problems;
        });
        Ok(())
    }

    /// Parse every changed unit in parallel and write what they say.
    ///
    /// Returns the problems encountered. A unit that cannot be read is reported
    /// and skipped: one unreadable file must not cost the whole scan. Each unit
    /// is written as soon as it is read, and `report` hears how far the scan
    /// has got every [`PROGRESS`].
    fn absorb(&self, changed: &[Unit], report: &impl Fn(&Status)) -> Vec<String> {
        if changed.is_empty() {
            return Vec::new();
        }
        let workers = std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(4)
            .min(changed.len());

        let next = AtomicUsize::new(0);
        let (send, receive) = mpsc::channel();
        let mut problems = Vec::new();

        std::thread::scope(|scope| {
            for _ in 0..workers {
                let send = send.clone();
                let next = &next;
                scope.spawn(move || {
                    loop {
                        let position = next.fetch_add(1, Ordering::Relaxed);
                        let Some(unit) = changed.get(position) else {
                            return;
                        };
                        let read = source::summarize(unit);
                        // The receiver lives until every worker has finished,
                        // so a send failure means the scan is being torn down.
                        if send.send((unit.clone(), read)).is_err() {
                            return;
                        }
                    }
                });
            }
            drop(send);

            let total = changed.len() as i64;
            let mut reported = Instant::now();
            for (done, (unit, read)) in (1..).zip(receive) {
                match read {
                    Ok(summaries) => match self.write(|store| store.put(&unit, &summaries)) {
                        Ok(()) => self
                            .changed
                            .lock()
                            .expect("never poisoned")
                            .extend(summaries.iter().map(|summary| summary.session.id.clone())),
                        Err(error) => problems.push(error.to_string()),
                    },
                    Err(error) => problems.push(error.to_string()),
                }
                if reported.elapsed() >= PROGRESS {
                    self.mark(|status| status.progress = Some((done, total)));
                    report(&self.status());
                    reported = Instant::now();
                }
            }
        });

        // A corpus with thousands of unreadable files should not produce
        // thousands of identical lines in the interface.
        problems.sort();
        problems.dedup();
        problems.truncate(20);
        problems
    }

    /// The sessions the last scan read anything new of, each once, so a window
    /// showing one can read it again without asking about the rest.
    pub fn changed(&self) -> Vec<String> {
        let mut changed = self.changed.lock().expect("never poisoned").clone();
        changed.sort();
        changed.dedup();
        changed
    }

    /// A window of one session's conversation.
    ///
    /// The whole conversation is parsed on the first request and held, so
    /// scrolling through a long session costs one read rather than one per
    /// page. Only the most recent session is kept: someone reads one
    /// conversation at a time, and the largest on this machine holds fifty
    /// megabytes of tool output.
    ///
    /// The counts of messages and tool calls are a by-product of that read, so
    /// they are stored rather than being made a reason to read the file twice.
    pub fn transcript(&self, id: &str, offset: i64, limit: i64) -> Result<Transcript> {
        self.held(id, |transcript| transcript.window(offset, limit))
    }

    /// Where every turn of a session's conversation falls, for its timeline.
    pub fn timeline(&self, id: &str) -> Result<Vec<crate::session::Mark>> {
        self.held(id, Transcript::marks)
    }

    /// Read from a session's whole conversation, parsing it unless it is the
    /// one already held.
    ///
    /// The lock is kept for the whole read, so a second request for a session
    /// still being parsed waits for that parse instead of starting another.
    fn held<T>(&self, id: &str, read: impl FnOnce(&Transcript) -> T) -> Result<T> {
        let mut open = self.open.lock().expect("never poisoned");
        if let Some(held) = open.as_ref()
            && held.id == id
        {
            return Ok(read(&held.transcript));
        }

        let located = self.read(|store| store.locate(id))?;
        let Some((unit, native_id)) = located else {
            return Err(crate::error::Error::NotFound(format!("session {id}")));
        };
        let transcript = source::transcript(&unit, &native_id)?;
        self.write(|store| store.put_counts(id, transcript.messages, transcript.tools))?;

        let result = read(&transcript);
        *open = Some(Held {
            id: id.to_owned(),
            path: unit.path.to_string_lossy().into_owned(),
            transcript,
        });
        Ok(result)
    }

    /// Forget the held conversation if a scan changed what it was read from:
    /// its file was rewritten, or its session has moved on to a newer file, as
    /// a resumed Codex thread does.
    ///
    /// Agents write every few seconds while they work, so releasing it on any
    /// change would parse a long conversation again for nearly every page read
    /// from it. A file that has gone leaves it held: what was read is still
    /// that session's history, and there is nothing newer to read.
    ///
    /// Locks the held conversation before the store, as [`Index::held`] does.
    fn release_if_stale(&self, changed: &[Unit]) -> Result<()> {
        if changed.is_empty() {
            return Ok(());
        }
        let mut open = self.open.lock().expect("never poisoned");
        let Some(held) = open.as_ref() else {
            return Ok(());
        };
        let rewritten = changed
            .iter()
            .any(|unit| unit.path.to_string_lossy() == held.path);
        if !rewritten {
            let located = self.read(|store| store.locate(&held.id))?;
            if located.is_some_and(|(unit, _)| unit.path.to_string_lossy() == held.path) {
                return Ok(());
            }
        }
        *open = None;
        Ok(())
    }

    /// Forget the held conversation, so its memory is returned.
    pub fn close(&self) {
        *self.open.lock().expect("never poisoned") = None;
    }

    /// Agents present on this machine, with where their history lives.
    pub fn agents(&self) -> Vec<(Agent, PathBuf)> {
        source::present(&self.home)
    }

    /// Record the latest read of one subscription's accounts.
    ///
    /// An account whose read failed keeps the limits last read successfully,
    /// with the reason they were not refreshed. An account no app holds a
    /// sign-in to any more is dropped. An account whose limits rose since a
    /// read shortly before is in use. What was read is kept for the next
    /// launch.
    pub fn record(&self, provider: Provider, mut accounts: Vec<Account>) -> Result<()> {
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
    use crate::session::{Filter, Problem};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// A home directory holding one Claude Code session.
    fn home() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temp dir");
        let projects = directory.path().join(".claude/projects/-w-proj");
        std::fs::create_dir_all(&projects).expect("creates");
        write_session(&projects.join("abc.jsonl"), "abc", "First prompt", 500);
        directory
    }

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
        let mut file = std::fs::File::create(path).expect("creates");
        file.write_all(contents.as_bytes()).expect("writes");
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
    fn rescanning_an_unchanged_corpus_reads_nothing() {
        let home = home();
        let index = index(&home);
        index.scan(|_| {}).expect("first scan");

        let second = index.scan(|_| {}).expect("second scan");
        assert_eq!(
            second.files_read, 0,
            "the unchanged file is not parsed again"
        );
        assert_eq!(second.sessions, 1);
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
            .transcript("claude_code:paged", 10, 10)
            .expect("reads");
        assert_eq!(second.turns[0].text, "Prompt 10");
        assert_eq!(second.total, 25);

        // Past the end is an empty page, not an error.
        let past = index
            .transcript("claude_code:paged", 25, 10)
            .expect("reads");
        assert!(past.turns.is_empty());
        assert_eq!(past.total, 25);

        // A negative offset reads from the start rather than panicking.
        let negative = index.transcript("claude_code:paged", -5, 3).expect("reads");
        assert_eq!(negative.turns[0].text, "Prompt 0");
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
    fn the_index_survives_being_reopened() {
        let home = home();
        {
            let index = index(&home);
            index.scan(|_| {}).expect("scans");
        }
        let reopened = index(&home);
        // Reopening must not rebuild: the count is read back from the store.
        assert_eq!(reopened.status().sessions, 1);
        let second = reopened.scan(|_| {}).expect("scans");
        assert_eq!(second.files_read, 0, "signatures survived the reopen");
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
                runs_out_at: None,
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
                runs_out_at: None,
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
