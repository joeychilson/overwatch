//! OpenCode.
//!
//! One SQLite database at `~/.local/share/opencode/opencode.db` holding every
//! session. `session_v2` holds each session's title and directory, and every
//! assistant message in `session_message` records its own time, model, tokens
//! and cost, so usage is counted per message.
//!
//! The database is opened read-only. OpenCode may be running and writing to it,
//! and this application never writes to an agent's own store.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;
use crate::price;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::source::{Conversation, Summary, Tally, Unit, compact, stat, text};

/// The database file, when it exists.
///
/// New messages land in SQLite's write-ahead log and reach the database file
/// only when the log is folded back in, so the log's changes count as the
/// database's.
pub fn discover(root: &Path) -> Vec<Unit> {
    let path = root.join("opencode.db");
    let Some((mtime, size)) = stat(&path) else {
        return Vec::new();
    };
    let (log_mtime, log_size) = stat(&root.join("opencode.db-wal")).unwrap_or((0, 0));
    vec![Unit {
        agent: Agent::OpenCode,
        path,
        mtime: mtime.max(log_mtime),
        size: size + log_size,
    }]
}

/// Open the agent's store without taking a write lock on it.
fn open(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?)
}

/// What an assistant message records about producing it.
#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    time: Value,
    #[serde(default)]
    model: Value,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    tokens: Option<Counts>,
}

/// The tokens one message used.
#[derive(Deserialize)]
struct Counts {
    #[serde(default)]
    input: i64,
    #[serde(default)]
    output: i64,
    #[serde(default)]
    reasoning: i64,
    #[serde(default)]
    cache: Cache,
}

/// Cached input a message read and wrote.
#[derive(Deserialize, Default)]
struct Cache {
    #[serde(default)]
    read: i64,
    #[serde(default)]
    write: i64,
}

/// Summarize every session in the database, counting usage per message.
pub fn summarize(source: &Unit) -> Result<Vec<Summary>> {
    let database = open(&source.path)?;
    let mut sessions: HashMap<String, (Session, Tally)> = HashMap::new();

    let mut statement = database.prepare(
        "SELECT id, title, directory, agent, time_created, time_updated, parent_id
         FROM session_v2",
    )?;
    let rows = statement.query_map([], |row| {
        let native_id: String = row.get(0)?;
        let parent: Option<String> = row.get(6)?;
        Ok(Session {
            id: format!("{}:{native_id}", Agent::OpenCode.key()),
            agent: Agent::OpenCode,
            native_id,
            title: row.get::<_, Option<String>>(1)?.filter(|t| !t.is_empty()),
            cwd: row.get(2)?,
            branch: None,
            started_at: crate::timestamp::from_unix_number(row.get(4)?).unwrap_or(source.mtime),
            updated_at: crate::timestamp::from_unix_number(row.get(5)?).unwrap_or(source.mtime),
            // A session with a parent was started by another session.
            spawned: parent.is_some(),
            role: row.get(3)?,
            models: Vec::new(),
            tokens: Tokens::default(),
            cost_usd: None,
            messages: None,
            tools: None,
            present: true,
        })
    })?;
    for session in rows.filter_map(std::result::Result::ok) {
        sessions.insert(session.native_id.clone(), (session, Tally::default()));
    }

    let mut messages = database
        .prepare("SELECT session_id, data FROM session_message WHERE type = 'assistant'")?;
    let mut rows = messages.query([])?;
    while let Some(row) = rows.next()? {
        let Some((session, tally)) = row
            .get_ref(0)?
            .as_str()
            .ok()
            .and_then(|id| sessions.get_mut(id))
        else {
            continue;
        };
        let data = row.get_ref(1)?.as_str().unwrap_or_default();
        let Ok(Reply {
            tokens: Some(counts),
            time,
            model,
            cost,
        }) = serde_json::from_str::<Reply>(data)
        else {
            continue;
        };
        let tokens = Tokens {
            input: counts.input,
            output: counts.output,
            cache_read: counts.cache.read,
            cache_write: counts.cache.write,
            reasoning: counts.reasoning,
            // OpenCode counts reasoning separately from output, so unlike
            // Claude Code it belongs in the total.
            total: counts.input
                + counts.output
                + counts.reasoning
                + counts.cache.read
                + counts.cache.write,
        };
        let at = crate::timestamp::from_json(&time["created"]).unwrap_or(session.updated_at);
        let id = model["id"].as_str().unwrap_or_default();
        let provider = model["providerID"].as_str().unwrap_or_default();
        let context = counts.input + counts.cache.read + counts.cache.write;
        // OpenCode records a cost only where it was billed one, so its own
        // figure stands in only for a model the catalog has no price for.
        let cost = price::rates(provider, id, context)
            .map(|rates| rates.cost(&tokens))
            .or(cost);
        tally.add(at, provider, id, tokens, cost);
    }

    Ok(sessions
        .into_values()
        .map(|(session, tally)| tally.summary(session))
        .collect())
}

/// The sessions any of whose records contain `needle`, ignoring the case of
/// ASCII letters: every session whose conversation could mention it, and
/// others whose records hold it elsewhere, found by one query rather than by
/// reading each session's messages.
pub fn holding(database: &Path, needle: &str) -> Result<HashSet<String>> {
    let pattern = format!(
        "%{}%",
        needle
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let database = open(database)?;
    let mut statement = database.prepare(
        "SELECT DISTINCT session_id FROM session_message WHERE data LIKE ?1 ESCAPE '\\'",
    )?;
    let sessions = statement.query_map([pattern], |row| row.get::<_, String>(0))?;
    Ok(sessions.collect::<rusqlite::Result<_>>()?)
}

/// Read one session's messages, in sequence order.
pub fn transcript(source: &Unit, native_id: &str) -> Result<Vec<Turn>> {
    let database = open(&source.path)?;
    let mut statement = database
        .prepare("SELECT type, data FROM session_message WHERE session_id = ?1 ORDER BY seq")?;
    let rows = statement.query_map([native_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut conversation = Conversation::default();

    for (kind, data) in rows.filter_map(std::result::Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let at = crate::timestamp::from_json(&message["time"]["created"]);
        let model = message["model"]["id"].as_str();
        let speaker = speaker_for(&kind);

        // A user message carries its prose in `text`; an assistant message
        // carries an ordered `content` list instead.
        let prose = message["text"].as_str().unwrap_or_default();
        if speaker == Speaker::User {
            conversation.prompt(at, prose);
        } else {
            conversation.say(speaker, at, model, prose);
        }

        for part in message["content"].as_array().into_iter().flatten() {
            let said = part["text"].as_str().unwrap_or_default();
            match part["type"].as_str() {
                Some("text") => conversation.say(speaker, at, model, said),
                Some("reasoning") => conversation.say(Speaker::Reasoning, at, model, said),
                Some("tool") => {
                    let state = &part["state"];
                    // A failed call records why under `error` and carries no
                    // content, so the reason is the result.
                    let output = state["error"]["message"]
                        .as_str()
                        .map_or_else(|| text(&state["content"]), str::to_owned);
                    let tool = ToolCall {
                        name: part["name"].as_str().unwrap_or("tool").to_owned(),
                        input: compact(&state["input"]),
                        output: Some(output).filter(|output| !output.is_empty()),
                        failed: state["status"] == "error",
                    };
                    let called = crate::timestamp::from_json(&part["time"]["created"]).or(at);
                    conversation.call(None, called, model, tool);
                }
                _ => {}
            }
        }
    }
    Ok(conversation.into_turns())
}

/// Who a stored message row is attributed to.
fn speaker_for(kind: &str) -> Speaker {
    match kind {
        "user" => Speaker::User,
        "assistant" => Speaker::Assistant,
        // `system`, `compaction`, `shell`, and `synthetic` are all harness
        // context rather than something a person or the model said.
        _ => Speaker::System,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::unit;

    #[test]
    fn a_change_to_the_write_ahead_log_is_a_change_to_the_database() {
        let directory = tempfile::tempdir().expect("temp dir");
        std::fs::write(directory.path().join("opencode.db"), b"db").expect("writes");
        let before = discover(directory.path()).remove(0);
        std::fs::write(directory.path().join("opencode.db-wal"), b"a new message").expect("writes");
        let after = discover(directory.path()).remove(0);
        assert_eq!(after.size, before.size + 13);
    }

    /// Build a store with the installed schema's columns for the rows we read.
    fn fixture() -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("opencode.db");
        let database = Connection::open(&path).expect("creates");
        database
            .execute_batch(
                "CREATE TABLE session_v2 (
                    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
                    directory TEXT, title TEXT, cost REAL DEFAULT 0 NOT NULL,
                    tokens_input INTEGER DEFAULT 0 NOT NULL,
                    tokens_output INTEGER DEFAULT 0 NOT NULL,
                    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
                    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
                    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
                    agent TEXT, model TEXT,
                    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
                 CREATE TABLE session_message (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
                    seq INTEGER NOT NULL, data TEXT NOT NULL);",
            )
            .expect("schema");
        database
            .execute(
                "INSERT INTO session_v2 (id, parent_id, directory, title, agent,
                    time_created, time_updated)
                 VALUES ('ses_top', NULL, '/w/proj', 'Explore Rust backend', 'explore',
                    1789020787098, 1789020787099)",
                [],
            )
            .expect("session row");
        database
            .execute(
                "INSERT INTO session_v2 (id, parent_id, directory, title, agent,
                    time_created, time_updated)
                 VALUES ('ses_child', 'ses_top', '/w/proj', 'subtask', NULL,
                    1789020788000, 1789020789000)",
                [],
            )
            .expect("child row");

        let assistant = r#"{"time":{"created":1788330606906},"model":{"id":"ling-3.0"},"cost":0.0214,
            "content":[{"type":"reasoning","text":"Thinking it through."},
                       {"type":"tool","name":"read","time":{"created":1788330606950},
                        "state":{"status":"completed","input":{"path":"/tmp/x"},
                                 "content":[{"type":"text","text":"file body"}]}},
                       {"type":"text","text":"ok"}],
            "tokens":{"input":4263,"output":2,"reasoning":12,"cache":{"read":0,"write":0}}}"#;
        database
            .execute(
                "INSERT INTO session_message (id, session_id, type, seq, data)
                 VALUES ('m1', 'ses_top', 'user', 1, '{\"time\":{\"created\":1788330605909},\"text\":\"Reply with ok\"}')",
                [],
            )
            .expect("user message");
        database
            .execute(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m2', 'ses_top', 'assistant', 2, ?1)",
                [assistant],
            )
            .expect("assistant message");
        drop(database);

        let source = unit(Agent::OpenCode, path).expect("unit");
        (directory, source)
    }

    #[test]
    fn the_sessions_holding_a_needle_are_found_in_one_query() {
        let (_directory, source) = fixture();
        let found = |needle: &str| {
            let mut sessions: Vec<_> = holding(&source.path, needle)
                .expect("queries")
                .into_iter()
                .collect();
            sessions.sort();
            sessions
        };
        assert_eq!(found("reply with"), ["ses_top"], "ASCII case is ignored");
        assert_eq!(found("file body"), ["ses_top"]);
        assert!(found("absent").is_empty());
        // A wildcard in the needle is only itself.
        assert!(found("reply%ok").is_empty());
        assert!(found("reply_with").is_empty());
    }

    /// One session of the fixture, as summarizing reads it.
    fn summarized(native_id: &str) -> Summary {
        let (_directory, source) = fixture();
        summarize(&source)
            .expect("summarizes")
            .into_iter()
            .find(|summary| summary.session.native_id == native_id)
            .expect("the session")
    }

    #[test]
    fn reads_every_session_with_usage_from_its_messages() {
        let (_directory, source) = fixture();
        assert_eq!(summarize(&source).expect("summarizes").len(), 2);

        let top = summarized("ses_top");
        assert_eq!(top.session.id, "open_code:ses_top");
        assert_eq!(top.session.title.as_deref(), Some("Explore Rust backend"));
        assert_eq!(top.session.cwd.as_deref(), Some("/w/proj"));
        assert_eq!(top.session.role.as_deref(), Some("explore"));
        assert!(!top.session.spawned);
        // Usage belongs to the model its message names.
        assert_eq!(top.models(), [("ling-3.0", 4_277)]);
        // The catalog has no price for it, so OpenCode's own figure stands.
        assert_eq!(top.cost(), Some(0.0214));
    }

    #[test]
    fn reasoning_counts_toward_the_total() {
        let tokens = summarized("ses_top").tokens();
        // 4_263 + 2 + 12, computed by hand. OpenCode reports reasoning
        // separately from output, so it is added here.
        assert_eq!(tokens.total, 4_277);
        assert_eq!(tokens.reasoning, 12);
    }

    #[test]
    fn a_session_with_a_parent_is_a_spawned_run() {
        let child = summarized("ses_child");
        assert!(child.session.spawned);
        assert!(child.usage.is_empty(), "it sent no messages");
    }

    #[test]
    fn a_transcript_reads_only_the_named_session() {
        let (_directory, source) = fixture();
        let read = crate::source::transcript(&source, "ses_top").expect("reads");

        assert_eq!(read.session_id, "open_code:ses_top");
        assert_eq!(read.messages, 2, "one prompt and one reply");
        assert_eq!(read.tools, 1);

        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::User,
                Speaker::Reasoning,
                Speaker::Tool,
                Speaker::Assistant
            ]
        );
        assert_eq!(read.turns[0].text, "Reply with ok");
        assert_eq!(read.turns[3].text, "ok");

        let tool = read.turns[2].tool.as_ref().expect("a tool call");
        assert_eq!(tool.name, "read");
        assert_eq!(tool.output.as_deref(), Some("file body"));
        assert!(!tool.failed);
        assert!(tool.input.contains("/tmp/x"));
    }

    #[test]
    fn a_failed_call_shows_why_it_failed() {
        let (_directory, source) = fixture();
        let database = Connection::open(&source.path).expect("opens");
        let rejected = r#"{"time":{"created":1788332935722},
            "content":[{"type":"tool","name":"write","time":{"created":1788332935722},
              "state":{"status":"error","input":{"path":"/forbidden"},
                       "error":{"type":"permission.rejected","message":"blocked by policy"}}}]}"#;
        database
            .execute(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m3','ses_top','assistant',3,?1)",
                [rejected],
            )
            .expect("writes");
        drop(database);

        let read = crate::source::transcript(&source, "ses_top").expect("reads");
        let failed = read
            .turns
            .iter()
            .find_map(|turn| turn.tool.as_ref().filter(|tool| tool.failed))
            .expect("a failed call");
        // An errored call records no content, so without the reason the
        // interface would say nothing was recorded at all.
        assert_eq!(failed.output.as_deref(), Some("blocked by policy"));
    }

    #[test]
    fn a_model_is_priced_by_its_id_and_counted_under_its_name() {
        let (_directory, source) = fixture();
        let database = Connection::open(&source.path).expect("opens");
        // Through OpenRouter the model carries its vendor. OpenCode's own $0.50
        // would stand in only for a model the catalog has no price for.
        let routed = r#"{"time":{"created":1788330700000},
            "model":{"id":"meta/muse-spark-1.3-contributor","providerID":"openrouter"},"cost":0.5,
            "tokens":{"input":1000,"output":500,"reasoning":0,"cache":{"read":2000,"write":0}}}"#;
        database
            .execute(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m3','ses_top','assistant',3,?1)",
                [routed],
            )
            .expect("writes");
        drop(database);

        let top = summarize(&source)
            .expect("summarizes")
            .into_iter()
            .find(|summary| summary.session.native_id == "ses_top")
            .expect("the session");
        let used = top
            .usage
            .iter()
            .find(|usage| usage.provider == "openrouter")
            .expect("the routed usage");
        assert_eq!(used.model, "muse-spark-1.3-contributor");
        // OpenRouter's $0.10 per million input, $0.20 output and $0.002 cache
        // reads: $0.0001 + $0.0001 + $0.000004.
        let cost = used.cost_usd.expect("priced");
        assert!((cost - 0.000_204).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn an_unknown_session_has_an_empty_transcript() {
        let (_directory, source) = fixture();
        let read = crate::source::transcript(&source, "ses_missing").expect("reads");
        assert!(read.turns.is_empty());
    }
}
