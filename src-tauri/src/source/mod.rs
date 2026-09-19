//! Reading the agents' own history files.
//!
//! A unit is read whole whenever it changes, and every usage record in it is
//! counted under the quarter hour it happened in, so a period or a day counts
//! only what was used within it: a thread resumed after a week adds today's
//! work to today, not its whole history. Each reader first undoes its agent's
//! quirks, such as Claude Code repeating a response's usage on every line of
//! it, or Codex keeping a running total that restarts when a thread resumes.
//!
//! No conversation text reaches the index: a conversation is read from its
//! unit when someone opens it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::price::{self, Rates};
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Transcript, Turn, holds};

mod claude;
mod codex;
mod grok;
mod opencode;
mod pi;

/// The longest title kept from an opening prompt, in characters.
const TITLE_LIMIT: usize = 160;

/// How finely usage is dated.
///
/// Every time-zone offset in use is a whole number of quarter hours, so a day
/// can be cut at any reader's midnight without splitting one.
pub(crate) const QUARTER_HOUR: i64 = 15 * 60_000;

/// One thing on disk that holds session history.
///
/// Usually a single session's file, but OpenCode keeps every session in one
/// database, so a unit may produce many sessions. It has changed when its
/// modification time or size has.
#[derive(Debug, Clone)]
pub struct Unit {
    /// Which agent wrote it.
    pub agent: Agent,
    /// Where it is.
    pub path: PathBuf,
    /// Last modification, in Unix milliseconds.
    pub mtime: i64,
    /// Size in bytes.
    pub size: i64,
}

/// A session as a reader found it in one unit, with the usage the unit holds.
pub struct Summary {
    /// The session's identity and times. Its totals and model shares are left
    /// empty: a session can span several units, as a Codex thread resumed into
    /// a new file does, so the store sums them from the usage of every one.
    pub session: Session,
    /// What it used, by quarter hour, provider and model.
    pub usage: Vec<Usage>,
}

/// What a session used in one quarter hour under one provider's model.
pub struct Usage {
    /// The start of the quarter hour, in Unix milliseconds.
    pub at: i64,
    /// Who served it, as the agent names them, such as `anthropic`.
    pub provider: String,
    /// The model's name: the id the agent recorded, less any path in front of
    /// it, or empty when the agent recorded none.
    pub model: String,
    /// Tokens used.
    pub tokens: Tokens,
    /// Estimated cost, where the model has a price.
    pub cost_usd: Option<f64>,
}

/// The most one record's usage can plausibly have cost, in dollars. A cost
/// beyond it, below zero or not a number is corrupt, so unknown; bounding each
/// keeps every sum of them finite, which the index needs to answer at all.
const MOST_COST: f64 = 1e9;

/// A session's usage, counted as a reader goes.
#[derive(Default)]
struct Tally {
    buckets: BTreeMap<(i64, String, String), (Tokens, Option<f64>)>,
}

impl Tally {
    /// Count usage that happened at `at` under `provider`'s model `id`.
    ///
    /// `cost_usd` is priced by `id`, the name the provider takes, but the usage
    /// is counted under [`model_name`], so every agent's name for one model is
    /// the same. A record of nothing, such as a reply Claude Code writes
    /// itself, is not usage.
    fn add(&mut self, at: i64, provider: &str, id: &str, tokens: Tokens, cost_usd: Option<f64>) {
        if tokens.is_empty() {
            return;
        }
        let quarter = at.div_euclid(QUARTER_HOUR) * QUARTER_HOUR;
        let (sum, spent) = self
            .buckets
            .entry((quarter, provider.to_owned(), model_name(id).to_owned()))
            .or_default();
        sum.add(tokens);
        if let Some(cost) = cost_usd.filter(|cost| (0.0..=MOST_COST).contains(cost)) {
            *spent.get_or_insert(0.0) += cost;
        }
    }

    /// The session, with the usage counted for it.
    fn summary(self, session: Session) -> Summary {
        let usage = self
            .buckets
            .into_iter()
            .map(|((at, provider, model), (tokens, cost_usd))| Usage {
                at,
                provider,
                model,
                tokens,
                cost_usd,
            })
            .collect();
        Summary { session, usage }
    }
}

/// The name a model is counted under: its id, less any path in front of it.
///
/// A provider serving other vendors' models puts a path before the model, as
/// OpenRouter's `google/gemini-3.8-flash` and Fireworks'
/// `accounts/fireworks/models/deepseek-v4-flash-0731` do, while the vendor
/// itself, and agents that drop the path, name the same model bare. Only the
/// path goes: a suffix such as `:free` marks a tier billed apart. An id with
/// nothing after its last slash is kept whole rather than counted as no model.
fn model_name(id: &str) -> &str {
    match id.rsplit_once('/') {
        Some((_, name)) if !name.is_empty() => name,
        _ => id,
    }
}

/// The sum of counts an agent recorded, which saturates rather than overflows
/// on a corrupt record.
fn sum<const N: usize>(counts: [i64; N]) -> i64 {
    counts.into_iter().fold(0, i64::saturating_add)
}

/// The rates `provider` lists for `model`, in the context tier reached by a
/// request that sent `tokens`: its input, fresh or cached.
fn rates(provider: &str, model: &str, tokens: &Tokens) -> Option<Rates> {
    let context = sum([tokens.input, tokens.cache_read, tokens.cache_write]);
    price::rates(provider, model, context)
}

/// A session found under `native_id`, known so far only by when it ran.
fn session(agent: Agent, native_id: String, started_at: i64, updated_at: i64) -> Session {
    Session {
        id: session_id(agent, &native_id),
        agent,
        native_id,
        title: None,
        cwd: None,
        branch: None,
        started_at,
        updated_at,
        spawned: false,
        role: None,
        models: Vec::new(),
        tokens: Tokens::default(),
        cost_usd: None,
        messages: None,
        tools: None,
        present: true,
    }
}

/// The id a session is known by, unique across agents.
fn session_id(agent: Agent, native_id: &str) -> String {
    format!("{}:{native_id}", agent.key())
}

/// Home directories of every agent present on this machine.
///
/// Returns only agents whose history directory exists, so a machine without
/// Codex never pays for looking and never reports a problem about it.
pub fn present(home: &Path) -> Vec<(Agent, PathBuf)> {
    Agent::ALL
        .into_iter()
        .filter_map(|agent| {
            let root = match agent {
                Agent::ClaudeCode => home.join(".claude/projects"),
                Agent::Codex => home.join(".codex"),
                Agent::OpenCode => home.join(".local/share/opencode"),
                Agent::Pi => home.join(".pi/agent/sessions"),
                Agent::GrokBuild => home.join(".grok/sessions"),
            };
            root.is_dir().then_some((agent, root))
        })
        .collect()
}

/// Every unit an agent has under its root.
pub fn discover(agent: Agent, root: &Path) -> Vec<Unit> {
    match agent {
        Agent::ClaudeCode => claude::discover(root),
        Agent::Codex => codex::discover(root),
        Agent::OpenCode => opencode::discover(root),
        Agent::Pi => pi::discover(root),
        Agent::GrokBuild => grok::discover(root),
    }
}

/// Summarize a unit, with its usage dated.
///
/// Usually one session; OpenCode keeps every session in a single database, so
/// its unit yields many. A unit that holds no usable session — an empty file,
/// or one whose header never arrived — yields none rather than failing, so one
/// truncated file cannot stop a scan.
pub fn summarize(unit: &Unit) -> Result<Vec<Summary>> {
    match unit.agent {
        Agent::ClaudeCode => claude::summarize(unit),
        Agent::Codex => codex::summarize(unit),
        Agent::OpenCode => opencode::summarize(unit),
        Agent::Pi => pi::summarize(unit),
        Agent::GrokBuild => grok::summarize(unit),
    }
}

/// Read one session's conversation in full.
pub fn transcript(unit: &Unit, native_id: &str) -> Result<Transcript> {
    let turns = match unit.agent {
        Agent::ClaudeCode => claude::transcript(unit),
        Agent::Codex => codex::transcript(unit, native_id),
        Agent::OpenCode => opencode::transcript(unit, native_id),
        Agent::Pi => pi::transcript(unit),
        Agent::GrokBuild => grok::transcript(unit),
    }?;
    Ok(Transcript::new(session_id(unit.agent, native_id), turns))
}

/// Where conversations are kept, and which could mention a search, looked up
/// once for a search of every conversation rather than once for each.
///
/// Finding a Codex thread's rollouts means walking every rollout on the
/// machine, and every OpenCode session is kept in one database, so asking each
/// once is most of what makes reading every conversation affordable.
pub struct Library {
    /// What is searched for, lowercase.
    needle: String,
    /// Every Codex rollout on this machine.
    rollouts: Vec<PathBuf>,
    /// OpenCode's database.
    database: PathBuf,
    /// The OpenCode sessions whose records hold the needle, or `None` when the
    /// database could not say. Asked when the first OpenCode session comes up,
    /// so a search of the others does not wait on it.
    opencode: OnceLock<Option<HashSet<String>>>,
}

impl Library {
    /// Look up where the conversations under `home` are kept, for a search of
    /// them for `needle`, which is lowercase.
    pub fn new(home: &Path, needle: &str) -> Library {
        Library {
            needle: needle.to_owned(),
            rollouts: codex::every_rollout(&home.join(".codex")),
            database: home.join(".local/share/opencode/opencode.db"),
            opencode: OnceLock::new(),
        }
    }

    /// Whether a session's conversation could mention the needle, judged
    /// without reading it: false only when it certainly cannot.
    pub fn may_mention(&self, unit: &Unit, native_id: &str) -> bool {
        if !plain(&self.needle) {
            return true;
        }
        let files = match unit.agent {
            Agent::ClaudeCode | Agent::Pi => vec![unit.path.clone()],
            Agent::Codex => codex::of_thread(&self.rollouts, &unit.path, native_id),
            Agent::GrokBuild => vec![grok::conversation(&unit.path)],
            Agent::OpenCode => {
                return self
                    .opencode
                    .get_or_init(|| opencode::holding(&self.database, &self.needle).ok())
                    .as_ref()
                    .is_none_or(|sessions| sessions.contains(native_id));
            }
        };
        // A file that cannot be read could hold anything, and reading the
        // conversation will report it.
        files.iter().any(|file| {
            std::fs::read(file).map_or(true, |bytes| holds(&bytes, self.needle.as_bytes()))
        })
    }

    /// Read one session's conversation in full, as [`transcript`] does.
    pub fn transcript(&self, unit: &Unit, native_id: &str) -> Result<Transcript> {
        match unit.agent {
            Agent::Codex => Ok(Transcript::new(
                session_id(unit.agent, native_id),
                codex::transcript_of(&codex::of_thread(&self.rollouts, &unit.path, native_id))?,
            )),
            _ => transcript(unit, native_id),
        }
    }
}

/// Whether a needle reads in a JSON file exactly as it is written, so that
/// missing from a file's bytes proves it absent: ASCII that no writer escapes.
/// Beyond ASCII some writers escape every character; a quote, a backslash or a
/// control character is always escaped; and some writers escape a slash, `<`,
/// `>`, `&` or `'`.
fn plain(needle: &str) -> bool {
    needle
        .bytes()
        .all(|byte| (byte == b' ' || byte.is_ascii_graphic()) && !b"\"\\/<>&'".contains(&byte))
}

/// A conversation as a reader assembles it, turn by turn.
///
/// A tool's result can arrive messages after its call, and calls made together
/// are answered in whatever order they finish, so a result is folded into the
/// call its id names rather than into whichever call came last.
#[derive(Default)]
struct Conversation {
    turns: Vec<Turn>,
    /// Calls not yet answered, by id, at their place in `turns`.
    awaiting: HashMap<String, usize>,
}

impl Conversation {
    /// Add something said, unless there is nothing in it to read.
    fn say(
        &mut self,
        speaker: Speaker,
        at: Option<i64>,
        model: Option<&str>,
        text: impl Into<String>,
    ) {
        let text = text.into();
        if !text.trim().is_empty() {
            self.push(speaker, at, model, text, None);
        }
    }

    /// Add a message sent as the person's, divided as [`prompt_parts`] divides
    /// it.
    fn prompt(&mut self, at: Option<i64>, text: &str) {
        for (speaker, part) in prompt_parts(text) {
            self.say(speaker, at, None, part);
        }
    }

    /// Add a tool call, which a later result can answer when it has an id.
    fn call(&mut self, id: Option<&str>, at: Option<i64>, model: Option<&str>, tool: ToolCall) {
        if let Some(id) = id {
            self.awaiting.insert(id.to_owned(), self.turns.len());
        }
        self.push(Speaker::Tool, at, model, String::new(), Some(tool));
    }

    /// Fold a result into the call it answers; one answering no call is dropped.
    fn answer(&mut self, id: &str, output: String, failed: bool) {
        // Every awaited position is a pushed turn, and turns are never removed.
        if let Some(tool) = self
            .awaiting
            .remove(id)
            .and_then(|position| self.turns[position].tool.as_mut())
        {
            tool.output = Some(output);
            tool.failed = failed;
        }
    }

    /// The turns, in order.
    fn into_turns(self) -> Vec<Turn> {
        self.turns
    }

    fn push(
        &mut self,
        speaker: Speaker,
        at: Option<i64>,
        model: Option<&str>,
        text: String,
        tool: Option<ToolCall>,
    ) {
        self.turns.push(Turn {
            // A vector's length never exceeds `isize::MAX`, so it fits.
            index: self.turns.len() as i64,
            speaker,
            at,
            model: model.map(str::to_owned),
            text,
            tool,
        });
    }
}

/// The pieces of text in a value that is a string or a list of blocks carrying
/// text.
fn pieces(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text],
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str().or_else(|| block.as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

/// The text of a value that is a string or a list of blocks carrying text, a
/// piece to a line.
fn text(value: &Value) -> String {
    match value {
        Value::Array(_) => pieces(value).join("\n"),
        other => compact(other),
    }
}

/// A value as text: a string as it is, null as nothing, and anything else, such
/// as a tool's arguments, as compact JSON.
fn compact(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A session's title from the pieces of a message sent as the person's: the
/// first line of their own words, unless those words are a slash command.
fn title_of<'a>(pieces: impl IntoIterator<Item = &'a str>) -> Option<String> {
    pieces
        .into_iter()
        .flat_map(prompt_parts)
        .filter(|(speaker, text)| *speaker == Speaker::User && !command(text))
        .find_map(|(_, text)| title_from(&text))
}

/// Turn an opening prompt into a one-line title: its first line with prose on
/// it, capped so one pasted paragraph cannot become the name of a session.
fn title_from(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('<') && !line.starts_with("#!"))?;
    let mut characters = line.chars();
    let mut title: String = characters.by_ref().take(TITLE_LIMIT).collect();
    if characters.next().is_some() {
        title.push('…');
    }
    Some(title)
}

/// Whether text is a slash command, such as `/model opus`, rather than prose
/// that opens with a path: a command's name has no further slash.
fn command(text: &str) -> bool {
    text.strip_prefix('/')
        .and_then(|rest| rest.split_whitespace().next())
        .is_some_and(|name| !name.contains('/'))
}

/// A message sent as the person's, divided into what they said and what their
/// harness put there.
///
/// Harnesses mark what they inject — `<environment_context>`,
/// `<system-reminder>`, `<task-notification>` — while people write prose, so
/// text opening with markup is the harness's, as are Codex's `AGENTS.md`
/// preamble and Claude Code's note of an interruption. Two kinds of markup hold
/// the person's own words: a slash command, and Grok's `<user_query>` after the
/// context it adds. The caveat Claude Code writes before a command's output
/// says nothing, and is left out.
fn prompt_parts(text: &str) -> Vec<(Speaker, String)> {
    let text = text.trim();
    if text.starts_with("<local-command-caveat>") {
        return Vec::new();
    }
    if text.starts_with("<command-name>") {
        let name = element(text, "command-name").map_or("", |(_, name)| name);
        let args = element(text, "command-args").map_or("", |(_, args)| args);
        return vec![(
            Speaker::User,
            format!("{name} {args}").trim_end().to_owned(),
        )];
    }
    if text.starts_with("<local-command-stdout>") {
        let output = element(text, "local-command-stdout").map_or(text, |(_, output)| output);
        return vec![(Speaker::System, output.to_owned())];
    }
    if text.starts_with('<')
        && let Some((span, query)) = element(text, "user_query")
    {
        let context = format!("{}{}", &text[..span.start], &text[span.end..]);
        return vec![
            (Speaker::System, context.trim().to_owned()),
            (Speaker::User, query.to_owned()),
        ];
    }
    let injected = text.starts_with('<')
        || text.starts_with("[Request interrupted")
        || text.starts_with("# AGENTS.md instructions");
    let speaker = if injected {
        Speaker::System
    } else {
        Speaker::User
    };
    vec![(speaker, text.to_owned())]
}

/// Where the first element named `tag` sits in `text`, and what it holds.
fn element<'a>(text: &'a str, tag: &str) -> Option<(Range<usize>, &'a str)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)?;
    let inner = start + open.len();
    let end = inner + text[inner..].find(&close)?;
    Some((start..end + close.len(), text[inner..end].trim()))
}

/// Read a whole file.
fn read_all(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|source| Error::Read {
        path: path.display().to_string(),
        source,
    })
}

/// The lines of a buffer that hold anything.
///
/// Line ends are found a vector's width at a time, which over the gigabytes a
/// scan reads is many times faster than splitting byte by byte.
fn lines(buffer: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut start = 0;
    memchr::memchr_iter(b'\n', buffer)
        .chain([buffer.len()])
        .map(move |end| {
            // Every end lies past the one before it, so the range is in bounds.
            let line = &buffer[start..end];
            start = end + 1;
            line
        })
        .filter(|line| line.iter().any(|byte| !byte.is_ascii_whitespace()))
}

/// A file's modification time, in Unix milliseconds, and size, as change
/// detection compares them; `None` when it cannot be read.
fn stat(path: &Path) -> Option<(i64, i64)> {
    let data = std::fs::metadata(path).ok()?;
    let modified = data.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((i64::try_from(millis).ok()?, i64::try_from(data.len()).ok()?))
}

/// Every `.jsonl` file under `root`, at any depth.
///
/// A directory that cannot be read is skipped: an unreadable project folder
/// should cost that folder, not the scan.
fn walk(root: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk(&path, found),
            Ok(kind)
                if kind.is_file() && path.extension().is_some_and(|found| found == "jsonl") =>
            {
                found.push(path);
            }
            _ => {}
        }
    }
}

/// The unit a file of `agent`'s is, or nothing if it has since disappeared.
fn unit(agent: Agent, path: PathBuf) -> Option<Unit> {
    let (mtime, size) = stat(&path)?;
    Some(Unit {
        agent,
        path,
        mtime,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Summary {
        /// Everything counted, as the store totals it.
        pub(super) fn tokens(&self) -> Tokens {
            let mut total = Tokens::default();
            for usage in &self.usage {
                total.add(usage.tokens);
            }
            total
        }

        /// The cost counted, unknown when no usage carries one.
        pub(super) fn cost(&self) -> Option<f64> {
            self.usage
                .iter()
                .filter_map(|usage| usage.cost_usd)
                .reduce(|sum, cost| sum + cost)
        }

        /// Tokens under each named model, largest first.
        pub(super) fn models(&self) -> Vec<(&str, i64)> {
            let mut models: Vec<(&str, i64)> = Vec::new();
            for usage in self.usage.iter().filter(|usage| !usage.model.is_empty()) {
                match models.iter_mut().find(|(model, _)| *model == usage.model) {
                    Some((_, total)) => *total += usage.tokens.total,
                    None => models.push((&usage.model, usage.tokens.total)),
                }
            }
            models.sort_by_key(|(_, total)| -total);
            models
        }
    }

    /// A unit of `agent`'s holding `contents`, in a directory that lasts as
    /// long as the guard returned with it.
    pub(super) fn journal(agent: Agent, contents: &str) -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("session.jsonl");
        std::fs::write(&path, contents).expect("writes");
        (directory, unit(agent, path).expect("unit"))
    }

    /// The one session a file of `agent`'s holding `contents` summarizes to.
    pub(super) fn summarized(agent: Agent, contents: &str) -> Summary {
        let (_directory, unit) = journal(agent, contents);
        summarize(&unit).expect("summarizes").remove(0)
    }

    /// The conversation a file of `agent`'s holding `contents` reads as.
    pub(super) fn transcribed(agent: Agent, contents: &str) -> Transcript {
        let (_directory, unit) = journal(agent, contents);
        transcript(&unit, "s").expect("reads")
    }

    fn tokens(total: i64) -> Tokens {
        Tokens {
            total,
            ..Tokens::default()
        }
    }

    #[test]
    fn a_cost_no_record_could_have_is_unknown() {
        let tokens = Tokens {
            input: 10,
            total: 10,
            ..Tokens::default()
        };
        let counted = |costs: &[f64]| {
            let mut tally = Tally::default();
            for &cost in costs {
                tally.add(0, "opencode", "m", tokens, Some(cost));
            }
            let usage = tally
                .summary(session(Agent::OpenCode, "a".into(), 0, 0))
                .usage;
            (usage[0].tokens.total, usage[0].cost_usd)
        };
        assert_eq!(counted(&[0.25, 0.5]), (20, Some(0.75)));
        // Two corrupt figures would add up to infinity, which the index could
        // not answer with; each is unknown instead, and the tokens still count.
        assert_eq!(counted(&[f64::MAX, f64::MAX, -1.0]), (30, None));
        assert_eq!(counted(&[f64::MAX, 0.5]), (20, Some(0.5)));
    }

    #[test]
    fn a_conversation_is_passed_over_only_when_its_file_cannot_hold_the_needle() {
        let (home, said) = journal(
            Agent::ClaudeCode,
            r#"{"content":"Add Idempotency-Key headers"}"#,
        );
        let may =
            |unit: &Unit, needle: &str| Library::new(home.path(), needle).may_mention(unit, "s");

        assert!(may(&said, "idempotency-key"), "case is ignored");
        assert!(may(&said, "add idem"));
        assert!(!may(&said, "refunds"));
        // A needle a writer might escape could be anywhere.
        for escaped in ["a \"quote\"", "a/b", "<tag>", "café", "it's"] {
            assert!(may(&said, escaped), "{escaped}");
        }
        // So could anything in a file that cannot be read.
        let gone = Unit {
            path: home.path().join("gone.jsonl"),
            ..said.clone()
        };
        assert!(may(&gone, "refunds"));
    }

    #[test]
    fn usage_is_dated_to_its_quarter_hour_and_split_by_model() {
        let mut tally = Tally::default();
        // 00:05 and 00:14 share the first quarter hour; 00:16 is in the next.
        tally.add(5 * 60_000, "p", "a", tokens(10), Some(0.5));
        tally.add(14 * 60_000, "p", "a", tokens(20), None);
        tally.add(16 * 60_000, "p", "b", tokens(30), None);
        // A record of nothing leaves no trace.
        tally.add(20 * 60_000, "p", "<synthetic>", Tokens::default(), None);
        let summary = tally.summary(session(Agent::Pi, "s".into(), 0, 0));

        let dated: Vec<_> = summary
            .usage
            .iter()
            .map(|usage| (usage.at, usage.model.as_str(), usage.tokens.total))
            .collect();
        assert_eq!(dated, [(0, "a", 30), (QUARTER_HOUR, "b", 30)]);
        // One priced record makes the bucket's cost known; unpriced usage adds
        // nothing to it.
        assert_eq!(summary.usage[0].cost_usd, Some(0.5));
        assert_eq!(summary.usage[1].cost_usd, None);
    }

    #[test]
    fn a_model_is_counted_under_its_name_whatever_path_its_id_carries() {
        let mut tally = Tally::default();
        // One model, with its vendor as OpenRouter takes it and bare as an
        // agent that drops the vendor records it.
        tally.add(
            0,
            "openrouter",
            "google/gemini-3.8-flash",
            tokens(10),
            Some(0.5),
        );
        tally.add(
            60_000,
            "openrouter",
            "gemini-3.8-flash",
            tokens(5),
            Some(0.25),
        );
        let summary = tally.summary(session(Agent::Pi, "s".into(), 0, 0));

        let counted: Vec<_> = summary
            .usage
            .iter()
            .map(|usage| (usage.at, usage.model.as_str(), usage.tokens.total))
            .collect();
        assert_eq!(counted, [(0, "gemini-3.8-flash", 15)]);
        assert_eq!(summary.usage[0].cost_usd, Some(0.75));
    }

    #[test]
    fn a_models_name_drops_only_the_path_in_front_of_it() {
        assert_eq!(model_name("claude-opus-5"), "claude-opus-5");
        assert_eq!(model_name("google/gemini-3.8-flash"), "gemini-3.8-flash");
        // Fireworks and Cloudflare nest the model deeper.
        assert_eq!(
            model_name("accounts/fireworks/models/deepseek-v4-flash-0731"),
            "deepseek-v4-flash-0731"
        );
        assert_eq!(model_name("@cf/openai/gpt-oss-120b"), "gpt-oss-120b");
        // A free tier is billed apart, so its suffix stays.
        assert_eq!(
            model_name("inclusionai/ling-3.0-flash-fin:free"),
            "ling-3.0-flash-fin:free"
        );
        // Nothing after the slash names no model, so the id is kept whole.
        assert_eq!(model_name("vendor/"), "vendor/");
        assert_eq!(model_name(""), "");
    }

    #[test]
    fn titles_take_the_first_line_of_prose() {
        assert_eq!(title_from("Fix the parser"), Some("Fix the parser".into()));
        // Leading blank lines and markup wrappers are skipped, not titled.
        assert_eq!(
            title_from("\n\n<local-command-caveat>ignore</local-command-caveat>\nReal prompt"),
            Some("Real prompt".into())
        );
        assert_eq!(title_from("   \n  \n"), None);
        assert_eq!(title_from(""), None);
    }

    #[test]
    fn long_titles_are_capped_in_characters_with_an_ellipsis() {
        // Cutting at a byte offset would split a multi-byte character.
        let title = title_from(&"é".repeat(500)).expect("has a title");
        assert_eq!(title.chars().count(), TITLE_LIMIT + 1);
        assert!(title.ends_with('…'));
        let exact = "é".repeat(TITLE_LIMIT);
        assert_eq!(title_from(&exact), Some(exact));
    }

    #[test]
    fn a_persons_message_is_told_apart_from_what_their_harness_added() {
        let user = |text: &str| vec![(Speaker::User, text.to_owned())];
        let system = |text: &str| vec![(Speaker::System, text.to_owned())];
        assert_eq!(prompt_parts("  Fix the parser\n"), user("Fix the parser"));
        let context = "<environment_context>\n<cwd>/w</cwd>\n</environment_context>";
        assert_eq!(prompt_parts(context), system(context));
        let instructions = "# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>";
        assert_eq!(prompt_parts(instructions), system(instructions));
        let interrupted = "[Request interrupted by user]";
        assert_eq!(prompt_parts(interrupted), system(interrupted));

        // A slash command is the person's, without its markup.
        let command = "<command-name>/effort</command-name>\n  <command-message>effort</command-message>\n  <command-args>high</command-args>";
        assert_eq!(prompt_parts(command), user("/effort high"));
        let output = "<local-command-stdout>Set model to Opus</local-command-stdout>";
        assert_eq!(prompt_parts(output), system("Set model to Opus"));
        assert!(
            prompt_parts("<local-command-caveat>Caveat: ignore</local-command-caveat>").is_empty()
        );

        // Grok puts the person's words after the context it adds.
        let grok =
            "<user_info>\nOS: macos\n</user_info>\n\n<user_query>\nIs this clean?\n</user_query>";
        assert_eq!(
            prompt_parts(grok),
            [
                (
                    Speaker::System,
                    "<user_info>\nOS: macos\n</user_info>".to_owned()
                ),
                (Speaker::User, "Is this clean?".to_owned()),
            ]
        );
    }

    #[test]
    fn titles_come_from_the_persons_own_words() {
        assert_eq!(
            title_of(["# AGENTS.md instructions for /w", "Fix the parser"]),
            Some("Fix the parser".into())
        );
        assert_eq!(title_of(["<command-name>/clear</command-name>"]), None);
        assert_eq!(title_of(["[Request interrupted by user]"]), None);
        // A path is not a command.
        assert_eq!(
            title_of(["/w/app.rs panics"]),
            Some("/w/app.rs panics".into())
        );
    }

    #[test]
    fn records_are_the_lines_that_hold_anything() {
        let found: Vec<&[u8]> = lines(b"a\n\n\nbc\n   \nd").collect();
        assert_eq!(found, [b"a".as_slice(), b"bc", b"d"]);
        assert_eq!(lines(b"{}\n").count(), 1);
        assert_eq!(lines(b"").count(), 0);
    }

    #[test]
    fn walking_finds_nested_journals() {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path();
        std::fs::create_dir_all(root.join("a/b")).expect("creates");
        for name in [
            "one.jsonl",
            "a/two.jsonl",
            "a/b/three.jsonl",
            "a/ignored.json",
        ] {
            std::fs::write(root.join(name), "{}").expect("writes");
        }

        let mut found = Vec::new();
        walk(root, &mut found);
        assert_eq!(found.len(), 3);
    }
}
