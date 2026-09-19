//! Codex.
//!
//! One JSONL rollout per thread under `~/.codex/sessions/<yyyy>/<mm>/<dd>/` and
//! `~/.codex/archived_sessions/`, opening with `session_meta`. Usage arrives in
//! `token_count` records as `total_token_usage`, a running total for the thread
//! that starts again from zero when the thread is resumed. So each record adds
//! what the total grew by since the one before it — or the whole total, after a
//! restart — to the model the thread was using then. A resumed thread can go on
//! in further rollouts that keep its id, and its conversation is read across
//! all of them.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;
use crate::price;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::source::{
    Conversation, Summary, Tally, Unit, contains, lines, pieces, read_all, title_of, unit, walk,
};

/// An envelope line.
///
/// The payload stays unparsed until the record's kind says it is wanted, which
/// is what keeps a 336 MB rollout from being turned into a tree of `Value`s
/// that is then thrown away.
#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", default)]
    kind: &'a str,
    #[serde(default)]
    timestamp: Option<&'a str>,
    /// The line's place in its thread, counted on across continuations.
    #[serde(default)]
    ordinal: Option<i64>,
    #[serde(default, borrow)]
    payload: Option<&'a serde_json::value::RawValue>,
}

/// The opening record of a rollout.
#[derive(Deserialize, Default)]
struct Meta {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    /// `"vscode"` or another originator for work a person started; an object
    /// with a `subagent` key for a run Codex spawned for itself.
    #[serde(default)]
    source: Value,
    #[serde(default)]
    thread_source: Option<String>,
    /// Where in its thread a continuing rollout picks up.
    #[serde(default)]
    history_base: Option<HistoryBase>,
}

/// The point a continuation picks up from: its thread's lines before
/// `end_ordinal_exclusive`.
#[derive(Deserialize)]
struct HistoryBase {
    #[serde(default)]
    end_ordinal_exclusive: i64,
}

/// A thread's running usage, as a `token_count` record reports it.
#[derive(Deserialize, Default)]
struct TotalUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    cached_input_tokens: i64,
    #[serde(default)]
    cache_write_input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    total_tokens: i64,
}

impl TotalUsage {
    /// What the running total grew by since `before`, or all of it when the
    /// count started again from zero.
    fn after(&self, before: &TotalUsage) -> Tokens {
        let zero = TotalUsage::default();
        let before = if self.total_tokens < before.total_tokens {
            &zero
        } else {
            before
        };
        let cache_read = self.cached_input_tokens - before.cached_input_tokens;
        Tokens {
            // Codex counts cached input inside its input; here it is apart.
            input: self.input_tokens - before.input_tokens - cache_read,
            output: self.output_tokens - before.output_tokens,
            cache_read,
            cache_write: self.cache_write_input_tokens - before.cache_write_input_tokens,
            // Codex counts reasoning inside its output.
            reasoning: 0,
            total: self.total_tokens - before.total_tokens,
        }
    }
}

/// The fields of a `response_item` a conversation actually shows.
///
/// Deliberately typed rather than a `serde_json::Value`: a rollout carries
/// megabytes of `encrypted_content` and tool output that never reaches the
/// screen, and naming only the wanted fields lets serde skip the rest without
/// allocating it. On the largest rollout here that is the difference between
/// half a second and a few tens of milliseconds.
#[derive(Deserialize)]
struct Item<'a> {
    #[serde(rename = "type", default)]
    kind: &'a str,
    #[serde(default)]
    role: Option<&'a str>,
    // Text is owned: serde cannot borrow a string with an escape in it, and
    // nearly every message has a line break.
    #[serde(default)]
    content: Option<Vec<Block>>,
    #[serde(default)]
    summary: Option<Vec<Block>>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    name: Option<&'a str>,
    #[serde(default)]
    namespace: Option<&'a str>,
    #[serde(default)]
    call_id: Option<&'a str>,
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
    #[serde(default)]
    output: Option<Output>,
}

/// An `event_msg` payload, as far as summaries and conversations read it.
#[derive(Deserialize)]
struct Event<'a> {
    #[serde(rename = "type", default)]
    kind: &'a str,
    #[serde(default)]
    info: Option<Info>,
    #[serde(default)]
    thread_settings: Option<Applied>,
}

/// What a `token_count` record carries: the thread's running total, and what
/// the latest request used on its own.
#[derive(Deserialize)]
struct Info {
    #[serde(default)]
    total_token_usage: Option<TotalUsage>,
    #[serde(default)]
    last_token_usage: Option<TotalUsage>,
}

/// The model thread settings or a turn's context put in force.
#[derive(Deserialize)]
struct Applied {
    #[serde(default)]
    model: Option<String>,
}

/// One block of a content or summary list.
#[derive(Deserialize)]
struct Block {
    #[serde(default)]
    text: Option<String>,
}

/// A tool's output, which is text in one shape and blocks in another.
#[derive(Deserialize)]
#[serde(untagged)]
enum Output {
    /// A plain string, as `function_call_output` writes it.
    Text(String),
    /// Blocks, as `custom_tool_call_output` writes them.
    Blocks(Vec<OutputBlock>),
}

/// One block of a tool's output.
#[derive(Deserialize)]
struct OutputBlock {
    #[serde(default)]
    text: String,
}

impl Output {
    /// The output as one piece of text.
    fn text(self) -> String {
        match self {
            Output::Text(text) => text,
            Output::Blocks(blocks) => blocks
                .into_iter()
                .map(|block| block.text)
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

/// Join the text of a block list.
fn joined(blocks: Option<Vec<Block>>) -> String {
    blocks
        .unwrap_or_default()
        .into_iter()
        .filter_map(|block| block.text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// How much of a line to inspect when deciding whether to parse it.
///
/// A rollout envelope writes `timestamp`, `ordinal`, and `type` before its
/// payload, and the payload's own `type` first, which puts both within the
/// first hundred bytes or so; this leaves generous room for that without
/// scanning the payload behind it.
const TYPE_WINDOW: usize = 256;

/// Every rollout, current and archived.
pub fn discover(root: &Path) -> Vec<Unit> {
    let mut paths = Vec::new();
    walk(&root.join("sessions"), "jsonl", &mut paths);
    walk(&root.join("archived_sessions"), "jsonl", &mut paths);
    paths
        .into_iter()
        .filter_map(|path| unit(Agent::Codex, path))
        .collect()
}

/// Summarize a rollout, counting each turn's usage when it happened.
pub fn summarize(source: &Unit) -> Result<Vec<Summary>> {
    let body = read_all(&source.path)?;
    let mut meta = None;
    let mut started_at = None;
    let mut updated_at = None;
    let mut title = None;
    let mut model = String::new();
    let mut counted = TotalUsage::default();
    let mut tally = Tally::default();
    let mut last: &[u8] = &[];

    for line in lines(&body) {
        last = line;
        // Nearly all of a long rollout is conversation, which a summary needs
        // only until it has a title, so the rest is passed over unparsed.
        let head = &line[..line.len().min(TYPE_WINDOW)];
        let wanted = contains(head, b"\"token_count\"")
            || contains(head, b"\"thread_settings_applied\"")
            || contains(head, b"\"turn_context\"")
            || contains(head, b"\"session_meta\"")
            || (title.is_none() && contains(head, b"\"response_item\""));
        if !wanted {
            continue;
        }
        let Ok(envelope) = serde_json::from_slice::<Line>(line) else {
            continue;
        };
        let Some(payload) = envelope.payload else {
            continue;
        };
        if let Some(at) = envelope.timestamp.and_then(crate::timestamp::parse_rfc3339) {
            started_at.get_or_insert(at);
            updated_at = Some(at);
        }

        match envelope.kind {
            // The first is the rollout's own; a subagent's rollout carries its
            // parent's after it.
            "session_meta" if meta.is_none() => {
                meta = Some(serde_json::from_str::<Meta>(payload.get()).unwrap_or_default());
            }
            "turn_context" => {
                if let Ok(Applied { model: Some(named) }) = serde_json::from_str(payload.get()) {
                    model = named;
                }
            }
            "event_msg" => {
                let Ok(event) = serde_json::from_str::<Event>(payload.get()) else {
                    continue;
                };
                if let Some(named) = event.thread_settings.and_then(|applied| applied.model) {
                    model = named;
                }
                let Some(Info {
                    total_token_usage: Some(usage),
                    last_token_usage,
                }) = event.info
                else {
                    continue;
                };
                let used = usage.after(&counted);
                // The latest request's input is the context its tier is set by.
                let context = last_token_usage.map_or(0, |last| last.input_tokens);
                let cost = price::rates("openai", &model, context).map(|rates| rates.cost(&used));
                tally.add(
                    updated_at.unwrap_or(source.mtime),
                    "openai",
                    &model,
                    used,
                    cost,
                );
                counted = usage;
            }
            "response_item" => {
                if let Ok(item) = serde_json::from_str::<Value>(payload.get())
                    && item["type"] == "message"
                    && item["role"] == "user"
                {
                    title = title_of(pieces(&item["content"]));
                }
            }
            _ => {}
        }
    }

    let mut meta = meta.unwrap_or_default();
    let Some(native_id) = meta.id.take().or(meta.session_id.take()) else {
        return Ok(Vec::new());
    };

    // A run Codex started for itself records what spawned it; work a person
    // started records only its originator, such as "vscode".
    let spawned = meta.source.get("subagent").is_some();
    let role = if spawned {
        meta.thread_source
            .take()
            .or_else(|| subagent_kind(&meta.source))
    } else {
        None
    };

    let started_at = meta
        .timestamp
        .as_deref()
        .and_then(crate::timestamp::parse_rfc3339)
        .or(started_at)
        .unwrap_or(source.mtime);
    // The last line is the latest activity, whatever kind of record it is.
    let updated_at = serde_json::from_slice::<Line>(last)
        .ok()
        .and_then(|line| line.timestamp)
        .and_then(crate::timestamp::parse_rfc3339)
        .or(updated_at)
        .unwrap_or(source.mtime);

    let session = Session {
        id: format!("{}:{native_id}", Agent::Codex.key()),
        agent: Agent::Codex,
        native_id,
        title,
        cwd: meta.cwd,
        branch: None,
        started_at,
        updated_at,
        spawned,
        role,
        models: Vec::new(),
        tokens: Tokens::default(),
        cost_usd: None,
        messages: None,
        tools: None,
        present: true,
    };
    Ok(vec![tally.summary(session)])
}

/// The kind of subagent a `source` object names, such as `guardian`.
fn subagent_kind(source: &Value) -> Option<String> {
    let subagent = source.get("subagent")?;
    if let Some(other) = subagent.get("other").and_then(Value::as_str) {
        return Some(other.to_owned());
    }
    subagent
        .as_object()
        .and_then(|fields| fields.keys().next().cloned())
}

/// Every rollout of a thread, oldest first: the files that carry its id in
/// their names, dated or archived.
pub fn rollouts(path: &Path, native_id: &str) -> Vec<PathBuf> {
    let home = path
        .ancestors()
        .find(|directory| {
            directory.ends_with("sessions") || directory.ends_with("archived_sessions")
        })
        .and_then(Path::parent);
    let every = match home {
        Some(home) if !native_id.is_empty() => every_rollout(home),
        _ => Vec::new(),
    };
    of_thread(&every, path, native_id)
}

/// Every rollout under a Codex home, dated or archived.
pub fn every_rollout(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    walk(&home.join("sessions"), "jsonl", &mut paths);
    walk(&home.join("archived_sessions"), "jsonl", &mut paths);
    paths
}

/// A thread's rollouts among `every`, oldest first: those that carry its id in
/// their names, or the file at `path` alone when none does.
pub fn of_thread(every: &[PathBuf], path: &Path, native_id: &str) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = if native_id.is_empty() {
        Vec::new()
    } else {
        every
            .iter()
            .filter(|candidate| {
                candidate
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().contains(native_id))
            })
            .cloned()
            .collect()
    };
    // Names begin with when the rollout was started.
    paths.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    if paths.is_empty() {
        paths.push(path.to_path_buf());
    }
    paths
}

/// Read a thread's conversation across every rollout it spans, pairing both
/// kinds of tool call.
pub fn transcript(source: &Unit, native_id: &str) -> Result<Vec<Turn>> {
    transcript_of(&rollouts(&source.path, native_id))
}

/// Read a thread's conversation from its rollouts, oldest first.
pub fn transcript_of(rollouts: &[PathBuf]) -> Result<Vec<Turn>> {
    let bodies = rollouts
        .iter()
        .map(|path| read_all(path))
        .collect::<Result<Vec<_>>>()?;

    // The lines a conversation shows, in the thread's order. A continuation
    // picks up where its `history_base` says the thread stood, so whatever came
    // after that point was abandoned, as by a rewind. A later rollout with no
    // base starts the conversation over, and continues only itself.
    let mut thread: Vec<Line> = Vec::new();
    let mut lineage = 0;
    for (position, body) in bodies.iter().enumerate() {
        let mut opened = position == 0;
        for line in lines(body) {
            // Most lines of a rollout are token counts, turn contexts and world
            // state, none of which a conversation shows. The envelope writes
            // its `type` before its payload, so the decision is made from the
            // head of the line without touching the megabytes that may follow.
            let head = &line[..line.len().min(TYPE_WINDOW)];
            if !(contains(head, b"\"response_item\"")
                || contains(head, b"\"session_meta\"")
                || contains(head, b"\"event_msg\""))
            {
                continue;
            }
            let Ok(envelope) = serde_json::from_slice::<Line>(line) else {
                continue;
            };
            if envelope.kind != "session_meta" {
                thread.push(envelope);
                continue;
            }
            // Only a rollout's own opening record says where it picks up.
            if !opened {
                let base = envelope
                    .payload
                    .and_then(|payload| serde_json::from_str::<Meta>(payload.get()).ok())
                    .and_then(|meta| meta.history_base);
                match base {
                    Some(base) => {
                        let end = Some(base.end_ordinal_exclusive);
                        let cut = thread[lineage..]
                            .iter()
                            .position(|kept| kept.ordinal >= end);
                        thread.truncate(cut.map_or(thread.len(), |at| lineage + at));
                    }
                    None => lineage = thread.len(),
                }
            }
            opened = true;
        }
    }

    let mut conversation = Conversation::default();
    let mut model = None;

    for envelope in thread {
        let Some(payload) = envelope.payload else {
            continue;
        };
        let at = envelope.timestamp.and_then(crate::timestamp::parse_rfc3339);

        match envelope.kind {
            "event_msg" => {
                if let Ok(event) = serde_json::from_str::<Event>(payload.get())
                    && event.kind == "thread_settings_applied"
                {
                    model = event.thread_settings.and_then(|applied| applied.model);
                }
                continue;
            }
            "response_item" => {}
            _ => continue,
        }

        let Ok(item) = serde_json::from_str::<Item>(payload.get()) else {
            continue;
        };
        let model = model.as_deref();
        match item.kind {
            "message" => match item.role {
                // What Codex sends as the person's arrives as blocks of their
                // message, beside what they typed.
                Some("user") => {
                    let blocks = item.content.into_iter().flatten();
                    for text in blocks.filter_map(|block| block.text) {
                        conversation.prompt(at, &text);
                    }
                }
                Some("assistant") => {
                    conversation.say(Speaker::Assistant, at, model, joined(item.content));
                }
                // Developer and system messages are harness context.
                _ => conversation.say(Speaker::System, at, model, joined(item.content)),
            },
            "agent_message" => {
                let said = item.message.unwrap_or_default();
                conversation.say(Speaker::Assistant, at, model, said);
            }
            // Only the readable summary; `encrypted_content` is opaque and is
            // never deserialized.
            "reasoning" => conversation.say(Speaker::Reasoning, at, model, joined(item.summary)),
            "custom_tool_call" | "function_call" => {
                let name = item.name.unwrap_or("tool");
                let tool = ToolCall {
                    name: match item.namespace {
                        Some(namespace) => format!("{namespace}.{name}"),
                        None => name.to_owned(),
                    },
                    input: item.input.or(item.arguments).unwrap_or_default(),
                    ..ToolCall::default()
                };
                conversation.call(item.call_id, at, model, tool);
            }
            "custom_tool_call_output" | "function_call_output" => {
                // Codex records no status on an output and no reliable failure
                // signal anywhere else: every one of the 29,152 outputs in the
                // reference corpus has `status: null`, and `exit_code` appears
                // in twenty of them. Guessing from the output text would put a
                // "Failed" badge on successful calls whose output merely
                // mentions one, so this reports no failure and lets the output
                // speak for itself.
                if let Some(call_id) = item.call_id {
                    let output = item.output.map(Output::text).unwrap_or_default();
                    conversation.answer(call_id, output, false);
                }
            }
            _ => {}
        }
    }
    Ok(conversation.into_turns())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(contents: &str) -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("rollout.jsonl");
        let mut file = std::fs::File::create(&path).expect("creates");
        file.write_all(contents.as_bytes()).expect("writes");
        let source = unit(Agent::Codex, path).expect("unit");
        (directory, source)
    }

    /// Shaped after a real rollout: two turns, each closed by a `token_count`.
    const ROLLOUT: &str = concat!(
        r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"session_id":"01a065fb","id":"01a06623","cwd":"/Users/me/Workspace/demo","originator":"codex-tui","source":"vscode","model_provider":"openai"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-03T07:20:03.000Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.5"}}}"#,
        "\n",
        r#"{"timestamp":"2026-09-03T07:20:04.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Optimize the library"}]}}"#,
        "\n",
        r#"{"timestamp":"2026-09-03T07:21:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":50,"cache_write_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":180},"last_token_usage":{"input_tokens":100}}}}"#,
        "\n",
        r#"{"timestamp":"2026-09-03T07:40:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2622652,"cached_input_tokens":2367488,"cache_write_input_tokens":10,"output_tokens":2750,"reasoning_output_tokens":1453,"total_tokens":2625402},"last_token_usage":{"input_tokens":300000}}}}"#,
        "\n",
    );

    #[test]
    fn each_turn_counts_what_the_running_total_grew_by_when_it_happened() {
        let (_directory, source) = fixture(ROLLOUT);
        let summary = summarize(&source).expect("summarizes").remove(0);

        // Adding the running totals up would count the first turn twice.
        let tokens = summary.tokens();
        assert_eq!(tokens.total, 2_625_402);
        // Codex counts the cached tokens inside its input: 2_622_652 - 2_367_488.
        assert_eq!(tokens.input, 255_164);
        assert_eq!(tokens.cache_read, 2_367_488);
        assert_eq!(tokens.output, 2_750);

        // The quarter hours from 07:15 and 07:30 on 2026-09-03, whose midnight
        // is 1_788_393_600 seconds.
        let dated: Vec<_> = summary
            .usage
            .iter()
            .map(|usage| (usage.at, usage.tokens.total))
            .collect();
        assert_eq!(
            dated,
            [(1_788_419_700_000, 180), (1_788_420_600_000, 2_625_222)]
        );
    }

    #[test]
    fn each_turn_is_priced_in_the_tier_its_latest_request_reached() {
        let (_directory, source) = fixture(ROLLOUT);
        let summary = summarize(&source).expect("summarizes").remove(0);
        let costs: Vec<_> = summary
            .usage
            .iter()
            .map(|usage| usage.cost_usd.expect("priced"))
            .collect();
        // GPT-5.5 at $5, $30, $0.50 and $5 per million: 250 + 600 + 25 + 50
        // millionths. The second turn's request held 300,000 tokens, past the
        // 272,000 above which input costs $10, output $45 and cache reads $1:
        // 2_551_140 + 122_850 + 2_367_438 millionths.
        assert_eq!(costs.len(), 2);
        assert!((costs[0] - 0.000_925).abs() < 1e-12, "got {costs:?}");
        assert!((costs[1] - 5.041_428).abs() < 1e-9, "got {costs:?}");
    }

    #[test]
    fn a_resumed_thread_counts_both_runs_each_under_its_own_model() {
        let resumed = concat!(
            r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"id":"r-1"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:03.000Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5-codex"}}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:21:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":500}}}}"#,
            "\n",
            // Resumed an hour later under another model, and counting anew.
            r#"{"timestamp":"2026-09-03T08:30:00.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T08:31:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120}}}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T08:32:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":200}}}}"#,
            "\n",
        );
        let (_directory, source) = fixture(resumed);
        let summary = summarize(&source).expect("summarizes").remove(0);

        // Keeping only the last total would say 200.
        assert_eq!(summary.models(), [("gpt-5-codex", 500), ("gpt-5.5", 200)]);
        // 08:32 on 2026-09-03, from the last line.
        assert_eq!(summary.session.updated_at, 1_788_424_320_000);
    }

    #[test]
    fn reads_identity_title_and_model() {
        let (_directory, source) = fixture(ROLLOUT);
        let summary = summarize(&source).expect("summarizes").remove(0);
        let session = &summary.session;

        // The rollout id, not the parent conversation id, identifies the file.
        assert_eq!(session.id, "codex:01a06623");
        assert_eq!(session.cwd.as_deref(), Some("/Users/me/Workspace/demo"));
        assert_eq!(session.title.as_deref(), Some("Optimize the library"));
        assert_eq!(summary.models(), [("gpt-5.5", 2_625_402)]);
        assert!(
            !session.spawned,
            "an originator string is a person's session"
        );
    }

    #[test]
    fn a_spawned_run_is_marked_with_what_it_was_for() {
        let spawned = concat!(
            r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"id":"sub-1","cwd":"/w","source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"}}"#,
            "\n",
            // The parent's record, which a spawned run's rollout carries after
            // its own.
            r#"{"timestamp":"2026-09-03T07:20:02.300Z","type":"session_meta","payload":{"id":"parent-1","source":"cli"}}"#,
            "\n",
        );
        let (_directory, source) = fixture(spawned);
        let session = summarize(&source).expect("summarizes").remove(0).session;
        assert_eq!(session.id, "codex:sub-1");
        assert!(session.spawned);
        assert_eq!(session.role.as_deref(), Some("guardian_review"));
    }

    #[test]
    fn a_spawned_run_without_a_thread_source_names_its_subagent() {
        let spawned = concat!(
            r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"id":"sub-2","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a0934d"}}}}}"#,
            "\n",
        );
        let (_directory, source) = fixture(spawned);
        let session = summarize(&source).expect("summarizes").remove(0).session;
        assert!(session.spawned);
        assert_eq!(session.role.as_deref(), Some("thread_spawn"));
    }

    #[test]
    fn a_rollout_with_no_meta_yields_nothing() {
        let (_directory, source) = fixture("{\"type\":\"event_msg\",\"payload\":{}}\n");
        assert!(summarize(&source).expect("summarizes").is_empty());
    }

    #[test]
    fn a_transcript_pairs_both_kinds_of_tool_call() {
        let conversation = concat!(
            r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"id":"t-1"}}"#,
            "\n",
            // Escaped text, as nearly every real message has, which must be
            // read rather than dropped.
            r#"{"timestamp":"2026-09-03T07:20:04.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Do it,\nand say \"done\""}]}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:05.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Planning."}],"encrypted_content":"opaque"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:06.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_A","name":"exec","input":"pwd"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:07.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_A","output":[{"type":"input_text","text":"/Users/me"}]}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:08.000Z","type":"response_item","payload":{"type":"function_call","call_id":"call_B","namespace":"collaboration","name":"spawn_agent","arguments":"{\"task\":\"x\"}"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:09.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_B","output":"{\"ok\":true}"}}"#,
            "\n",
        );
        let (_directory, source) = fixture(conversation);
        let read = crate::source::transcript(&source, "t-1").expect("reads");

        assert_eq!(read.tools, 2);
        assert_eq!(read.messages, 1);
        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::User,
                Speaker::Reasoning,
                Speaker::Tool,
                Speaker::Tool
            ]
        );
        // Only the readable summary of reasoning survives.
        assert_eq!(read.turns[1].text, "Planning.");

        let exec = read.turns[2].tool.as_ref().expect("a tool call");
        assert_eq!(exec.name, "exec");
        assert_eq!(exec.output.as_deref(), Some("/Users/me"));

        let spawn = read.turns[3].tool.as_ref().expect("a tool call");
        // A namespaced tool keeps its namespace, which is how Codex names it.
        assert_eq!(spawn.name, "collaboration.spawn_agent");
        assert_eq!(spawn.output.as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn developer_messages_are_context_not_conversation() {
        let conversation = concat!(
            r#"{"timestamp":"2026-09-03T07:20:02.227Z","type":"session_meta","payload":{"id":"d-1"}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:04.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>"}]}}"#,
            "\n",
            // Sent as the person's, but written by Codex.
            r##"{"timestamp":"2026-09-03T07:20:05.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>"}]}}"##,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:06.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/w</cwd>\n</environment_context>"}]}}"#,
            "\n",
            r#"{"timestamp":"2026-09-03T07:20:07.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the parser"}]}}"#,
            "\n",
        );
        let (_directory, source) = fixture(conversation);
        let read = crate::source::transcript(&source, "d-1").expect("reads");
        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::System,
                Speaker::System,
                Speaker::System,
                Speaker::User
            ]
        );
        assert_eq!(read.messages, 1, "context is not a message exchanged");
        let summary = summarize(&source).expect("summarizes").remove(0);
        assert_eq!(summary.session.title.as_deref(), Some("Fix the parser"));
    }

    #[test]
    fn a_thread_reads_on_across_its_rollouts() {
        let home = tempfile::tempdir().expect("temp dir");
        let write = |relative: &str, lines: &[&str]| {
            let path = home.path().join(relative);
            std::fs::create_dir_all(path.parent().expect("a folder")).expect("creates");
            std::fs::write(&path, lines.join("\n")).expect("writes");
            path
        };
        write(
            "sessions/2026/09/13/rollout-2026-09-13T02-16-56-01a0aaaa.jsonl",
            &[
                r#"{"ordinal":0,"type":"session_meta","payload":{"id":"01a0aaaa"}}"#,
                r#"{"ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Start"}]}}"#,
                r#"{"ordinal":2,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Planned"}]}}"#,
                r#"{"ordinal":3,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Rewound"}]}}"#,
            ],
        );
        // Picks up before the last line above, which was abandoned.
        write(
            "sessions/2026/09/13/rollout-2026-09-13T02-48-20-01a0aaaa_01a0cccc.jsonl",
            &[
                r#"{"ordinal":3,"type":"session_meta","payload":{"id":"01a0aaaa","history_base":{"thread_id":"01a0aaaa","end_ordinal_exclusive":3}}}"#,
                r#"{"ordinal":4,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Carry on"}]}}"#,
            ],
        );
        // Archived, and started over with nothing in common with the above.
        write(
            "archived_sessions/rollout-2026-09-14T09-00-00-01a0aaaa_01a0dddd.jsonl",
            &[
                r#"{"ordinal":0,"type":"session_meta","payload":{"id":"01a0aaaa"}}"#,
                r#"{"ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fresh start"}]}}"#,
                r#"{"ordinal":2,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Dropped"}]}}"#,
            ],
        );
        // Picks up the conversation that started over, so "Planned", which has
        // the same ordinal as "Dropped", stays.
        let latest = write(
            "archived_sessions/rollout-2026-09-14T09-30-00-01a0aaaa_01a0eeee.jsonl",
            &[
                r#"{"ordinal":2,"type":"session_meta","payload":{"id":"01a0aaaa","history_base":{"thread_id":"01a0aaaa","end_ordinal_exclusive":2}}}"#,
                r#"{"ordinal":2,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Picked up"}]}}"#,
            ],
        );
        // Another thread's rollout, filed beside them.
        write(
            "sessions/2026/09/13/rollout-2026-09-13T03-00-00-01a0bbbb.jsonl",
            &[
                r#"{"ordinal":0,"type":"session_meta","payload":{"id":"01a0bbbb"}}"#,
                r#"{"ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Elsewhere"}]}}"#,
            ],
        );

        let source = unit(Agent::Codex, latest).expect("unit");
        let read = crate::source::transcript(&source, "01a0aaaa").expect("reads");
        let texts: Vec<_> = read.turns.iter().map(|turn| turn.text.as_str()).collect();
        assert_eq!(
            texts,
            ["Start", "Planned", "Carry on", "Fresh start", "Picked up"]
        );
    }
}
