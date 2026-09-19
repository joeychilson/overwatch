//! Grok.
//!
//! One directory per session under `~/.grok/sessions/<encoded cwd>/<id>/`.
//! `summary.json` holds the identity, the generated title, the branch, and both
//! timestamps; `chat_history.jsonl` the conversation.
//!
//! `updates.jsonl` records each finished turn's usage per model, with what xAI
//! charged for it. That charge is the turn's cost as it stands: the catalog
//! does not list Grok's build model, and a turn of many requests could not be
//! priced in the right context tier anyway. The `totalTokens` other updates
//! carry is the size of the context, not usage. Sessions without the file
//! record usage nowhere, and report none.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use memchr::memmem;
use serde::Deserialize;
use serde_json::Value;

use super::{
    Conversation, Summary, Tally, Unit, compact, lines, pieces, read_all, session, stat, text,
};
use crate::error::Result;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::timestamp;

/// The files a session directory holds, each of which Grok writes at its own
/// time: a turn's usage and a generated title can land minutes after the chat.
const FILES: [&str; 3] = ["chat_history.jsonl", "summary.json", "updates.jsonl"];

/// The contents of a session's `summary.json`.
#[derive(Deserialize, Default)]
#[serde(default)]
struct SummaryFile {
    info: Info,
    generated_title: Option<String>,
    session_summary: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    last_active_at: Option<String>,
    head_branch: Option<String>,
    agent_name: Option<String>,
}

/// The identity block of a summary.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Info {
    id: Option<String>,
    cwd: Option<String>,
}

/// What one model used over a finished turn, as Grok reports it.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ModelUsage {
    input_tokens: i64,
    output_tokens: i64,
    cached_read_tokens: i64,
    cache_creation_tokens: i64,
    total_tokens: i64,
    /// What xAI charged, in ticks of a ten-billionth of a dollar.
    cost_usd_ticks: Option<i64>,
}

impl ModelUsage {
    /// The turn's tokens. Grok's total is its input plus its output, so what
    /// was read from or written to cache is inside the input, and reasoning is
    /// inside the output.
    fn tokens(&self) -> Tokens {
        Tokens {
            input: self
                .input_tokens
                .saturating_sub(self.cached_read_tokens)
                .saturating_sub(self.cache_creation_tokens),
            output: self.output_tokens,
            cache_read: self.cached_read_tokens,
            cache_write: self.cache_creation_tokens,
            reasoning: 0,
            total: self.total_tokens,
        }
    }
}

/// Every session directory beneath the per-project folders, changed when any
/// of its files has.
pub(super) fn discover(root: &Path) -> Vec<Unit> {
    let Ok(projects) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut units = Vec::new();
    for project in projects.flatten() {
        let Ok(sessions) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let directory = session.path();
            if !directory.join("summary.json").is_file() {
                continue;
            }
            let (mtime, size) = FILES
                .iter()
                .filter_map(|name| stat(&directory.join(name)))
                .fold((0, 0_i64), |(mtime, size), (modified, length)| {
                    (mtime.max(modified), size.saturating_add(length))
                });
            units.push(Unit {
                agent: Agent::GrokBuild,
                path: directory,
                mtime,
                size,
            });
        }
    }
    units
}

/// Summarize a session from its `summary.json`, with its usage dated.
pub(super) fn summarize(source: &Unit) -> Result<Vec<Summary>> {
    let body = read_all(&source.path.join("summary.json"))?;
    let Ok(summary) = serde_json::from_slice::<SummaryFile>(&body) else {
        return Ok(Vec::new());
    };
    let Some(native_id) = summary.info.id else {
        return Ok(Vec::new());
    };

    let started_at = summary
        .created_at
        .as_deref()
        .and_then(timestamp::parse_rfc3339)
        .unwrap_or(source.mtime);
    let updated_at = summary
        .updated_at
        .as_deref()
        .or(summary.last_active_at.as_deref())
        .and_then(timestamp::parse_rfc3339)
        .unwrap_or(source.mtime);

    let tally = usage(&source.path, updated_at)?;
    Ok(vec![tally.summary(Session {
        title: summary.generated_title.or(summary.session_summary),
        cwd: summary.info.cwd,
        branch: summary.head_branch,
        role: summary.agent_name,
        ..session(Agent::GrokBuild, native_id, started_at, updated_at)
    })])
}

/// A session's usage, from the finished turns in its `updates.jsonl`, each
/// dated when it finished or, with no time, `fallback`. A turn cancelled
/// before the model answered records none, and one cancelled partway records
/// no charge.
fn usage(directory: &Path, fallback: i64) -> Result<Tally> {
    let mut tally = Tally::default();
    let path = directory.join("updates.jsonl");
    if !path.is_file() {
        return Ok(tally);
    }
    for line in lines(&read_all(&path)?) {
        if memmem::find(line, b"\"modelUsage\"").is_none() {
            continue;
        }
        let Ok(update) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(Ok(models)) = update
            .pointer("/params/update/usage/modelUsage")
            .map(HashMap::<String, ModelUsage>::deserialize)
        else {
            continue;
        };
        let at = update["timestamp"]
            .as_i64()
            .and_then(timestamp::from_unix_number)
            .unwrap_or(fallback);
        for (model, used) in models {
            let cost = used.cost_usd_ticks.map(|ticks| ticks as f64 / 1e10);
            tally.add(at, "xai", &model, used.tokens(), cost);
        }
    }
    Ok(tally)
}

/// The file a session's conversation is kept in, within its directory.
pub(super) fn conversation(directory: &Path) -> PathBuf {
    directory.join("chat_history.jsonl")
}

/// Read a session's chat history, which records no per-message time or model.
pub(super) fn transcript(source: &Unit) -> Result<Vec<Turn>> {
    let body = read_all(&conversation(&source.path))?;
    let mut conversation = Conversation::default();

    for line in lines(&body) {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match record["type"].as_str() {
            Some("user") => {
                for piece in pieces(&record["content"]) {
                    conversation.prompt(None, piece);
                }
            }
            Some("system") => {
                conversation.say(Speaker::System, None, None, text(&record["content"]));
            }
            Some("reasoning") => {
                conversation.say(Speaker::Reasoning, None, None, text(&record["summary"]));
            }
            Some("assistant") => {
                conversation.say(Speaker::Assistant, None, None, text(&record["content"]));
                // Grok attaches a turn's calls to the message that made them.
                for call in record["tool_calls"].as_array().into_iter().flatten() {
                    let tool = ToolCall {
                        name: call["name"].as_str().unwrap_or("tool").to_owned(),
                        input: compact(&call["arguments"]),
                        ..ToolCall::default()
                    };
                    conversation.call(call["id"].as_str(), None, None, tool);
                }
            }
            Some("tool_result") => {
                if let Some(id) = record["tool_call_id"].as_str() {
                    let failed = record["is_error"].as_bool().unwrap_or(false);
                    conversation.answer(id, text(&record["content"]), failed);
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

    const SUMMARY: &str = r#"{
      "info": {"id": "01a07107", "cwd": "/Users/me/Workspace/overwatch"},
      "session_summary": "Codebase Organization",
      "created_at": "2026-09-05T10:04:55.302948Z",
      "updated_at": "2026-09-05T11:09:06.705536Z",
      "num_messages": 131,
      "current_model_id": "grok-4.6",
      "head_branch": "main",
      "generated_title": "Codebase Organization and Cleanliness Assessment",
      "agent_name": "grok-build-plan"
    }"#;

    /// A session directory holding `summary.json` and the given chat history,
    /// with the session's one unit.
    fn session_with(chat: &[&str]) -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path().join("sessions/%2Fw/01a07107");
        std::fs::create_dir_all(&root).expect("creates");
        std::fs::write(root.join("summary.json"), SUMMARY).expect("writes");
        std::fs::write(root.join("chat_history.jsonl"), chat.join("\n")).expect("writes");
        let unit = discover(&directory.path().join("sessions")).remove(0);
        (directory, unit)
    }

    fn fixture() -> (tempfile::TempDir, Unit) {
        session_with(&[
            r#"{"type":"system","content":"You are Grok."}"#,
            r#"{"type":"user","content":[{"type":"text","text":"Is this clean?"}]}"#,
            r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"Exploring."}],"encrypted_content":"opaque"}"#,
            r#"{"type":"assistant","content":"I'll look through the repo.","tool_calls":[{"id":"call-a","name":"list_dir","arguments":"{\"target\":\"/w\"}"}]}"#,
            r#"{"type":"tool_result","tool_call_id":"call-a","content":"README.md"}"#,
        ])
    }

    #[test]
    fn reads_identity_and_title_from_the_summary() {
        let (_directory, source) = fixture();
        let summary = summarize(&source).expect("summarizes").remove(0);
        let session = summary.session;

        assert_eq!(session.id, "grok_build:01a07107");
        assert_eq!(
            session.title.as_deref(),
            Some("Codebase Organization and Cleanliness Assessment"),
            "the generated title wins over the shorter summary"
        );
        assert_eq!(
            session.cwd.as_deref(),
            Some("/Users/me/Workspace/overwatch")
        );
        assert_eq!(session.branch.as_deref(), Some("main"));
        assert_eq!(session.role.as_deref(), Some("grok-build-plan"));
        // Independently known from the fixture's own RFC 3339 text.
        assert_eq!(session.started_at, 1_788_602_695_302);
        assert_eq!(session.updated_at, 1_788_606_546_705);
        // Without `updates.jsonl` there is no usage to report.
        assert!(summary.usage.is_empty());
    }

    #[test]
    fn usage_that_cannot_be_read_is_a_problem_rather_than_none() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, source) = fixture();
        let updates = source.path.join("updates.jsonl");
        std::fs::write(&updates, "{}\n").expect("writes");
        std::fs::set_permissions(&updates, std::fs::Permissions::from_mode(0o000))
            .expect("hides it");
        // Reporting the file keeps a session from showing as having used nothing.
        assert!(matches!(
            summarize(&source),
            Err(crate::error::Error::Read { .. })
        ));
    }

    #[test]
    fn each_finished_turn_counts_its_usage_and_charge_when_it_finished() {
        let (_directory, source) = fixture();
        std::fs::write(
            source.path.join("updates.jsonl"),
            [
                // The size of the context, which is not usage.
                r#"{"timestamp":1788602706,"method":"session/update","params":{"_meta":{"totalTokens":126847}}}"#,
                r#"{"timestamp":1788602906,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn","usage":{"inputTokens":2687582,"outputTokens":49850,"totalTokens":2737432,"cachedReadTokens":2135296,"cacheCreationTokens":0,"reasoningTokens":24859,"costUsdTicks":4201244000,"modelUsage":{"grok-4.6-build":{"inputTokens":2687582,"outputTokens":49850,"totalTokens":2737432,"cachedReadTokens":2135296,"cacheCreationTokens":0,"reasoningTokens":24859,"costUsdTicks":4201244000}}}},"_meta":{"totalTokens":126847}}}"#,
                // Cancelled before the model answered.
                r#"{"timestamp":1788603000,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"cancelled"}}}"#,
                // Cancelled partway, with usage but no charge.
                r#"{"timestamp":1788603906,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"cancelled","usage":{"modelUsage":{"grok-4.6-build":{"inputTokens":1000,"outputTokens":50,"totalTokens":1050,"cachedReadTokens":800,"cacheCreationTokens":0}},"usageIsIncomplete":true}}}}"#,
            ]
            .join("\n"),
        )
        .expect("writes");
        let summary = summarize(&source).expect("summarizes").remove(0);
        assert_eq!(summary.models(), [("grok-4.6-build", 2_738_482)]);

        let tokens = summary.tokens();
        // Cached input is inside Grok's input: 2_687_582 - 2_135_296 + 1_000 - 800.
        assert_eq!(tokens.input, 552_486);
        assert_eq!(tokens.cache_read, 2_136_096);
        assert_eq!(tokens.output, 49_900);

        // Quarter hours from 1_788_602_400 s and 1_788_603_300 s. 4_201_244_000
        // ticks is $0.4201244; the turn cancelled partway was charged nothing
        // Grok recorded.
        let dated: Vec<_> = summary
            .usage
            .iter()
            .map(|usage| (usage.at, usage.tokens.total, usage.cost_usd))
            .collect();
        assert_eq!(
            dated,
            [
                (1_788_602_400_000, 2_737_432, Some(0.420_124_4)),
                (1_788_603_300_000, 1_050, None)
            ]
        );
    }

    #[test]
    fn a_session_is_read_again_when_any_of_its_files_changes() {
        let (directory, before) = fixture();
        // Grok writes a turn's usage, and later its title, after the chat that
        // the turn ended with; watching the chat alone missed both.
        std::fs::write(before.path.join("updates.jsonl"), "{}\n").expect("writes");
        let after = discover(&directory.path().join("sessions")).remove(0);
        assert_eq!(after.size, before.size + 3);
    }

    #[test]
    fn discovery_skips_directories_with_no_summary() {
        let directory = tempfile::tempdir().expect("temp dir");
        let stray = directory.path().join("sessions/%2Fw/not-a-session");
        std::fs::create_dir_all(&stray).expect("creates");
        std::fs::write(stray.join("events.jsonl"), "{}\n").expect("writes");
        assert!(discover(&directory.path().join("sessions")).is_empty());
    }

    #[test]
    fn a_transcript_pairs_calls_attached_to_a_message() {
        let (_directory, source) = fixture();
        let read = crate::source::transcript(&source, "01a07107").expect("reads");

        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::System,
                Speaker::User,
                Speaker::Reasoning,
                Speaker::Assistant,
                Speaker::Tool
            ]
        );
        assert_eq!(
            read.messages, 2,
            "system prompts are not exchanged messages"
        );
        assert_eq!(read.tools, 1);
        assert_eq!(read.turns[2].text, "Exploring.");

        let tool = read.turns[4].tool.as_ref().expect("a tool call");
        assert_eq!(tool.name, "list_dir");
        assert_eq!(tool.input, r#"{"target":"/w"}"#);
        assert_eq!(tool.output.as_deref(), Some("README.md"));
    }

    #[test]
    fn results_pair_by_id_even_when_they_arrive_out_of_order() {
        let (_directory, source) = session_with(&[
            r#"{"type":"assistant","content":"Working.","tool_calls":[{"id":"call-a","name":"list_dir","arguments":"{}"},{"id":"call-b","name":"read_file","arguments":"{}"}]}"#,
            // Answered second-call-first, which is what the real corpus does.
            r#"{"type":"tool_result","tool_call_id":"call-b","content":"file body"}"#,
            r#"{"type":"tool_result","tool_call_id":"call-a","content":"README.md"}"#,
        ]);

        let read = crate::source::transcript(&source, "01a07107").expect("reads");
        let named = |name: &str| {
            read.turns
                .iter()
                .find_map(|turn| turn.tool.as_ref().filter(|tool| tool.name == name))
                .unwrap_or_else(|| panic!("{name} is missing"))
        };
        assert_eq!(named("list_dir").output.as_deref(), Some("README.md"));
        assert_eq!(named("read_file").output.as_deref(), Some("file body"));
    }
}
