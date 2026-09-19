//! Reading the agents' own history files.
//!
//! # Usage is dated by when it happened
//!
//! Every usage record a session holds is counted and dated to the quarter hour
//! it happened in, so a period or a day counts only what was used within it: a
//! thread resumed after a week adds today's work to today, not its whole
//! history. That takes every record, so a unit is read whole — but only when it
//! changed since the last scan, and the files are local.
//!
//! Each agent writes usage its own way, and each reader undoes that agent's
//! quirks before counting: Claude Code repeats a response's usage on every line
//! of the response, and Codex keeps a running total that starts again when a
//! thread is resumed.
//!
//! No conversation text is copied into the database: a conversation is read
//! from its unit when someone opens it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Transcript, Turn};

pub mod claude;
pub mod codex;
pub mod grok;
pub mod opencode;
pub mod pi;

/// The longest title kept from an opening prompt.
const TITLE_LIMIT: usize = 160;

/// How finely usage is dated.
///
/// Every time-zone offset in use is a whole number of quarter hours, so a day
/// can be cut at any reader's midnight without splitting one.
pub(crate) const QUARTER_HOUR: i64 = 15 * 60_000;

/// One thing on disk that holds session history.
///
/// Usually a single session's file, but OpenCode keeps every session in one
/// database, so a unit may produce many sessions. Change detection is the same
/// either way: the modification time and size the scan last saw.
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
    /// What it used, by quarter hour and model.
    pub usage: Vec<Usage>,
}

/// What a session used in one quarter hour under one provider's model.
pub struct Usage {
    /// The start of the quarter hour, in Unix milliseconds.
    pub at: i64,
    /// Who served it, as the agent names them, such as `anthropic`.
    pub provider: String,
    /// The model's name, as `model_name` gives it, or empty when the agent
    /// recorded none.
    pub model: String,
    /// Tokens used.
    pub tokens: Tokens,
    /// Estimated cost, where the model has a price.
    pub cost_usd: Option<f64>,
}

/// The most one record's usage can plausibly have cost, in dollars. A cost
/// beyond it, below zero or not a number is corrupt, so unknown; bounding each
/// keeps every sum of them finite.
const MOST_COST: f64 = 1e9;

/// A session's usage, counted as a reader goes.
#[derive(Default)]
pub struct Tally {
    buckets: BTreeMap<(i64, String, String), (Tokens, Option<f64>)>,
}

impl Tally {
    /// Count usage that happened at `at` under `provider`'s model `id`.
    ///
    /// `id` is the model as the agent recorded it, which is what `cost_usd`
    /// must be priced by: the catalog lists each provider's models by the ids
    /// that provider takes. The usage is counted under the model's name
    /// instead. Naming it here, rather than in each reader, keeps every
    /// agent's name for a model the same, and folds ids of one name into one
    /// bucket before the store's key could see them as two.
    pub fn add(
        &mut self,
        at: i64,
        provider: &str,
        id: &str,
        tokens: Tokens,
        cost_usd: Option<f64>,
    ) {
        // A record of nothing, such as a reply Claude Code writes itself, is
        // not usage.
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
    pub fn summary(self, session: Session) -> Summary {
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

#[cfg(test)]
impl Summary {
    /// Everything counted, as the store totals it.
    pub fn tokens(&self) -> Tokens {
        let mut total = Tokens::default();
        for usage in &self.usage {
            total.add(usage.tokens);
        }
        total
    }

    /// The cost counted, unknown when no usage carries one.
    pub fn cost(&self) -> Option<f64> {
        self.usage
            .iter()
            .filter_map(|usage| usage.cost_usd)
            .reduce(|sum, cost| sum + cost)
    }

    /// Tokens under each named model, largest first.
    pub fn models(&self) -> Vec<(&str, i64)> {
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

/// Where conversations are kept, and which could mention a search, looked up
/// once for a search of every conversation rather than once for each.
///
/// Finding a Codex thread's rollouts means walking every rollout on the
/// machine, and every OpenCode session is kept in one database; asking each
/// once for the whole search is most of what makes reading them all
/// affordable.
pub struct Library {
    /// What is searched for, lowercase.
    needle: String,
    /// Every Codex rollout on this machine.
    rollouts: Vec<PathBuf>,
    /// OpenCode's database.
    database: PathBuf,
    /// The OpenCode sessions whose records hold the needle, or `None` when that
    /// cannot be told from them, so every one could. Asked for when the first
    /// OpenCode session comes up, so a search of the rest does not wait on it.
    opencode: OnceLock<Option<HashSet<String>>>,
}

impl Library {
    /// Look up where the conversations under `home` are kept, for a search of
    /// them for `needle`, which is lowercase.
    pub fn new(home: &Path, needle: &str) -> Library {
        let codex = home.join(".codex");
        Library {
            needle: needle.to_owned(),
            rollouts: if codex.is_dir() {
                codex::every_rollout(&codex)
            } else {
                Vec::new()
            },
            database: home.join(".local/share/opencode/opencode.db"),
            opencode: OnceLock::new(),
        }
    }

    /// Whether a session's conversation could mention the needle, judged
    /// without reading it: false only when it certainly cannot.
    pub fn may_mention(&self, unit: &Unit, native_id: &str) -> bool {
        let files = match unit.agent {
            Agent::ClaudeCode | Agent::Pi => vec![unit.path.clone()],
            Agent::Codex => codex::of_thread(&self.rollouts, &unit.path, native_id),
            Agent::GrokBuild => vec![grok::conversation(&unit.path)],
            Agent::OpenCode => {
                return self
                    .opencode
                    .get_or_init(|| {
                        plain(&self.needle)
                            .then(|| opencode::holding(&self.database, &self.needle).ok())
                            .flatten()
                    })
                    .as_ref()
                    .is_none_or(|sessions| sessions.contains(native_id));
            }
        };
        may_contain(&files, &self.needle)
    }

    /// Read one session's conversation in full, as [`transcript`] does.
    pub fn transcript(&self, unit: &Unit, native_id: &str) -> Result<Transcript> {
        match unit.agent {
            Agent::Codex => Ok(Transcript::new(
                conversation_id(unit, native_id),
                codex::transcript_of(&codex::of_thread(&self.rollouts, &unit.path, native_id))?,
            )),
            _ => transcript(unit, native_id),
        }
    }
}

/// Whether a needle reads in a JSON file as it is written: ASCII that no
/// writer escapes, so finding it missing from a file's bytes proves it absent.
/// Beyond ASCII, some writers escape every character; a quote, a backslash or
/// a control character is always escaped; and some writers escape a slash,
/// `<`, `>`, `&` or `'`.
fn plain(needle: &str) -> bool {
    needle
        .bytes()
        .all(|byte| (byte == b' ' || byte.is_ascii_graphic()) && !b"\"\\/<>&'".contains(&byte))
}

/// Whether a conversation read from `files` could contain `needle`, which is
/// lowercase, judged from the files' bytes without parsing them, so that one
/// which cannot is passed over.
///
/// It answers no only when that is certain: a needle that is not [`plain`]
/// could be written otherwise and so could be anywhere, and so could anything
/// in a file that cannot be read, which reading the conversation will report.
pub fn may_contain(files: &[PathBuf], needle: &str) -> bool {
    !plain(needle)
        || files
            .iter()
            .any(|file| std::fs::read(file).map_or(true, |bytes| holds(&bytes, needle.as_bytes())))
}

/// Whether `haystack` holds `needle`, ignoring the case of ASCII letters.
///
/// It jumps from one place the needle's first letter stands, in either case,
/// to the next, a vector's width at a time, and compares the rest only there:
/// a search reads every conversation on the machine this way.
fn holds(haystack: &[u8], needle: &[u8]) -> bool {
    let Some((&first, rest)) = needle.split_first() else {
        return true;
    };
    let (lower, upper) = (first.to_ascii_lowercase(), first.to_ascii_uppercase());
    memchr::memchr2_iter(lower, upper, haystack).any(|at| {
        haystack
            .get(at + 1..at + 1 + rest.len())
            .is_some_and(|tail| tail.eq_ignore_ascii_case(rest))
    })
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
    Ok(Transcript::new(conversation_id(unit, native_id), turns))
}

/// The id a conversation is known by, as its session is.
fn conversation_id(unit: &Unit, native_id: &str) -> String {
    format!("{}:{native_id}", unit.agent.key())
}

/// A conversation as a reader assembles it, turn by turn.
///
/// A tool's result can arrive messages after its call, and calls made together
/// are answered in whatever order they finish, so a result is folded into the
/// call its id names rather than into whichever call came last.
#[derive(Default)]
pub struct Conversation {
    turns: Vec<Turn>,
    awaiting: HashMap<String, usize>,
}

impl Conversation {
    /// Add something said, unless there is nothing in it to read.
    pub fn say(
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
    pub fn prompt(&mut self, at: Option<i64>, text: &str) {
        for (speaker, part) in prompt_parts(text) {
            self.say(speaker, at, None, part);
        }
    }

    /// Add a tool call, which a later result can answer when it has an id.
    pub fn call(&mut self, id: Option<&str>, at: Option<i64>, model: Option<&str>, tool: ToolCall) {
        if let Some(id) = id {
            self.awaiting.insert(id.to_owned(), self.turns.len());
        }
        self.push(Speaker::Tool, at, model, String::new(), Some(tool));
    }

    /// Fold a result into the call it answers; one answering no call is dropped.
    pub fn answer(&mut self, id: &str, output: String, failed: bool) {
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
    pub fn into_turns(self) -> Vec<Turn> {
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
pub fn pieces(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text],
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str().or_else(|| block.as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

/// The text of a value that is a string or a list of blocks carrying text.
pub fn text(value: &Value) -> String {
    match value {
        Value::String(_) | Value::Array(_) => pieces(value).join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Tool arguments as text: a string as it is, anything else as compact JSON.
pub fn compact(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Read a whole file.
pub fn read_all(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|source| Error::Read {
        path: path.display().to_string(),
        source,
    })
}

/// The non-empty lines of a buffer.
pub fn lines(buffer: &[u8]) -> impl Iterator<Item = &[u8]> {
    buffer
        .split(|byte| *byte == b'\n')
        .filter(|line| line.iter().any(|byte| !byte.is_ascii_whitespace()))
}

/// Whether a buffer contains a byte sequence, without decoding it.
pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Turn an opening prompt into a one-line title.
///
/// Prompts arrive with leading blank lines, pasted context, and command markup.
/// The title is the first line with prose on it, capped so one pasted paragraph
/// cannot become the name of a session.
fn title_from(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('<') && !line.starts_with("#!"))?;
    let mut title: String = line.chars().take(TITLE_LIMIT).collect();
    if line.chars().count() > TITLE_LIMIT {
        title.push('…');
    }
    Some(title)
}

/// A session's title from the pieces of a message sent as the person's: the
/// first line of their own words, unless those words are a slash command.
pub fn title_of<'a>(pieces: impl IntoIterator<Item = &'a str>) -> Option<String> {
    pieces
        .into_iter()
        .flat_map(prompt_parts)
        .filter(|(speaker, text)| *speaker == Speaker::User && !command(text))
        .find_map(|(_, text)| title_from(&text))
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
pub fn prompt_parts(text: &str) -> Vec<(Speaker, String)> {
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

/// A file's modification time and size, as change detection uses them.
pub fn stat(path: &Path) -> Option<(i64, i64)> {
    let data = std::fs::metadata(path).ok()?;
    let modified = data.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((millis as i64, data.len() as i64))
}

/// Every file under `root` matching an extension, at any depth.
///
/// Directory entries that cannot be read are skipped: an unreadable project
/// folder should cost that folder, not the scan.
pub fn walk(root: &Path, extension: &str, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk(&path, extension, found),
            Ok(kind)
                if kind.is_file() && path.extension().is_some_and(|found| found == extension) =>
            {
                found.push(path);
            }
            _ => {}
        }
    }
}

/// Build a [`Unit`] for a path, or nothing if it has since disappeared.
pub fn unit(agent: Agent, path: PathBuf) -> Option<Unit> {
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
    use std::fs::File;
    use std::io::Write;

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
            let (tokens, cost) = tally.buckets.into_values().next().expect("one bucket");
            (tokens.total, cost)
        };
        assert_eq!(counted(&[0.25, 0.5]), (20, Some(0.75)));
        // Two corrupt figures would add up to infinity; each is unknown
        // instead, and the tokens still count.
        assert_eq!(counted(&[f64::MAX, f64::MAX, -1.0]), (30, None));
        assert_eq!(counted(&[f64::MAX, 0.5]), (20, Some(0.5)));
    }

    #[test]
    fn a_file_is_passed_over_only_when_it_cannot_hold_the_needle() {
        let directory = tempfile::tempdir().expect("temp dir");
        let said = directory.path().join("said.jsonl");
        std::fs::write(&said, r#"{"content":"Add Idempotency-Key headers"}"#).expect("writes");
        let other = directory.path().join("other.jsonl");
        std::fs::write(&other, r#"{"content":"Nothing here"}"#).expect("writes");
        let files = [said.clone(), other.clone()];

        assert!(may_contain(&files, "idempotency-key"), "case is ignored");
        assert!(may_contain(&files, "add idem"));
        assert!(!may_contain(&files, "refunds"));
        assert!(!may_contain(std::slice::from_ref(&other), "idempotency"));
        // A needle a writer might escape could be anywhere.
        for escaped in ["a \"quote\"", "a/b", "<tag>", "café", "it's"] {
            assert!(
                may_contain(std::slice::from_ref(&other), escaped),
                "{escaped}"
            );
        }
        // So could anything in a file that cannot be read.
        assert!(may_contain(
            &[directory.path().join("gone.jsonl")],
            "idempotency"
        ));
    }

    fn write(directory: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = directory.join(name);
        let mut file = File::create(&path).expect("creates");
        file.write_all(contents).expect("writes");
        path
    }

    fn tokens(total: i64) -> Tokens {
        Tokens {
            total,
            ..Tokens::default()
        }
    }

    fn session() -> Session {
        Session {
            id: "pi:s".into(),
            agent: Agent::Pi,
            native_id: "s".into(),
            title: None,
            cwd: None,
            branch: None,
            started_at: 0,
            updated_at: 0,
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

    #[test]
    fn usage_is_dated_to_its_quarter_hour_and_split_by_model() {
        let mut tally = Tally::default();
        // 00:05 and 00:14 share the first quarter hour; 00:16 is in the next.
        tally.add(5 * 60_000, "p", "a", tokens(10), Some(0.5));
        tally.add(14 * 60_000, "p", "a", tokens(20), None);
        tally.add(16 * 60_000, "p", "b", tokens(30), None);
        // A record of nothing leaves no trace.
        tally.add(20 * 60_000, "p", "<synthetic>", Tokens::default(), None);
        let summary = tally.summary(session());

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
        let summary = tally.summary(session());

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
    fn long_titles_are_capped_with_an_ellipsis() {
        let long = "w".repeat(500);
        let title = title_from(&long).expect("has a title");
        assert_eq!(title.chars().count(), TITLE_LIMIT + 1);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn titles_count_characters_not_bytes() {
        // Truncating by byte offset would split a multi-byte character and
        // panic; the cap is expressed in characters for that reason.
        let long = "é".repeat(500);
        let title = title_from(&long).expect("has a title");
        assert_eq!(title.chars().count(), TITLE_LIMIT + 1);
    }

    #[test]
    fn blank_lines_are_not_records() {
        assert_eq!(lines(b"a\n\n\nb\n   \nc").count(), 3);
    }

    #[test]
    fn walking_finds_nested_files_of_one_extension() {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path();
        std::fs::create_dir_all(root.join("a/b")).expect("creates");
        write(root, "one.jsonl", b"{}");
        write(&root.join("a"), "two.jsonl", b"{}");
        write(&root.join("a/b"), "three.jsonl", b"{}");
        write(&root.join("a"), "ignored.json", b"{}");

        let mut found = Vec::new();
        walk(root, "jsonl", &mut found);
        assert_eq!(found.len(), 3);
    }
}
