//! Grok.
//!
//! One directory per session under `~/.grok/sessions/<encoded cwd>/<id>/`.
//! `summary.json` already holds the identity, the generated title, the model,
//! the branch, and both timestamps.
//!
//! `updates.jsonl` records each finished turn's usage per model, with what xAI
//! charged for it. That charge is the turn's cost as it stands: the catalog
//! does not list Grok's build model, and a turn of many requests could not be
//! priced in the right context tier anyway. The `totalTokens` other updates
//! carry is the size of the context, not usage. Sessions without the file
//! record usage nowhere, and report none.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::source::{
    Conversation, Summary, Tally, Unit, contains, lines, pieces, read_all, stat, text,
};

/// The contents of a session's `summary.json`.
#[derive(Deserialize, Default)]
struct SummaryFile {
    #[serde(default)]
    info: Info,
    #[serde(default)]
    generated_title: Option<String>,
    #[serde(default)]
    session_summary: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    last_active_at: Option<String>,
    #[serde(default)]
    head_branch: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
}

/// The identity block of a summary.
#[derive(Deserialize, Default)]
struct Info {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

/// Every session directory beneath the per-project folders.
pub fn discover(root: &Path) -> Vec<Unit> {
    let mut units = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return units;
    };
    for project in projects.flatten() {
        let Ok(sessions) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let directory = session.path();
            if !directory.join("summary.json").is_file() {
                continue;
            }
            // The conversation file is what changes as a session runs, so it
            // is the signal for whether this unit needs re-reading. A directory
            // modification time would not move when a file inside it grows.
            let (mtime, size) = stat(&directory.join("chat_history.jsonl"))
                .or_else(|| stat(&directory.join("summary.json")))
                .unwrap_or((0, 0));
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
pub fn summarize(source: &Unit) -> Result<Vec<Summary>> {
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
        .and_then(crate::timestamp::parse_rfc3339)
        .unwrap_or(source.mtime);
    let updated_at = summary
        .updated_at
        .as_deref()
        .or(summary.last_active_at.as_deref())
        .and_then(crate::timestamp::parse_rfc3339)
        .unwrap_or(source.mtime);

    let tally = usage(&source.path, updated_at);
    let session = Session {
        id: format!("{}:{native_id}", Agent::GrokBuild.key()),
        agent: Agent::GrokBuild,
        native_id,
        title: summary.generated_title.or(summary.session_summary),
        cwd: summary.info.cwd,
        branch: summary.head_branch,
        started_at,
        updated_at,
        spawned: false,
        role: summary.agent_name,
        models: Vec::new(),
        tokens: Tokens::default(),
        cost_usd: None,
        messages: None,
        tools: None,
        present: true,
    };
    Ok(vec![tally.summary(session)])
}

/// What one model used over a finished turn, as Grok reports it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cached_read_tokens: i64,
    #[serde(default)]
    cache_creation_tokens: i64,
    #[serde(default)]
    total_tokens: i64,
    /// What xAI charged, in ticks of a ten-billionth of a dollar.
    #[serde(default)]
    cost_usd_ticks: Option<i64>,
}

impl ModelUsage {
    /// The turn's tokens. Grok's total is its input plus its output, so what
    /// was read from or written to cache is inside the input, and reasoning is
    /// inside the output.
    fn tokens(&self) -> Tokens {
        Tokens {
            input: self.input_tokens - self.cached_read_tokens - self.cache_creation_tokens,
            output: self.output_tokens,
            cache_read: self.cached_read_tokens,
            cache_write: self.cache_creation_tokens,
            reasoning: 0,
            total: self.total_tokens,
        }
    }
}

/// A session's usage, from the finished turns in its `updates.jsonl`, each
/// dated when it finished or, with no time, `fallback`. A turn cancelled
/// before the model answered records none, and one cancelled partway records
/// no charge.
fn usage(directory: &Path, fallback: i64) -> Tally {
    let mut tally = Tally::default();
    let Ok(body) = read_all(&directory.join("updates.jsonl")) else {
        return tally;
    };
    for line in lines(&body) {
        if !contains(line, b"\"modelUsage\"") {
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
            .and_then(crate::timestamp::from_unix_number)
            .unwrap_or(fallback);
        for (model, used) in models {
            let cost = used.cost_usd_ticks.map(|ticks| ticks as f64 / 1e10);
            tally.add(at, "xai", &model, used.tokens(), cost);
        }
    }
    tally
}

/// The file a session's conversation is kept in, within its directory.
pub fn conversation(directory: &Path) -> PathBuf {
    directory.join("chat_history.jsonl")
}

/// Read a session's chat history, which records no per-message time or model.
pub fn transcript(source: &Unit) -> Result<Vec<Turn>> {
    let body = read_all(&conversation(&source.path))?;
    let mut conversation = Conversation::default();

    for line in lines(&body) {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let content = text(&record["content"]);
        match record["type"].as_str() {
            Some("user") => {
                for piece in pieces(&record["content"]) {
                    conversation.prompt(None, piece);
                }
            }
            Some("system") => conversation.say(Speaker::System, None, None, content),
            Some("reasoning") => {
                conversation.say(Speaker::Reasoning, None, None, text(&record["summary"]));
            }
            Some("assistant") => {
                conversation.say(Speaker::Assistant, None, None, content);
                // Grok attaches a turn's calls to the message that made them.
                for call in record["tool_calls"].as_array().into_iter().flatten() {
                    let tool = ToolCall {
                        name: call["name"].as_str().unwrap_or("tool").to_owned(),
                        input: call["arguments"].as_str().unwrap_or_default().to_owned(),
                        ..ToolCall::default()
                    };
                    conversation.call(call["id"].as_str(), None, None, tool);
                }
            }
            Some("tool_result") => {
                if let Some(id) = record["tool_call_id"].as_str() {
                    let failed = record["is_error"].as_bool().unwrap_or(false);
                    conversation.answer(id, content, failed);
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

    fn write(path: &Path, contents: &str) {
        let mut file = std::fs::File::create(path).expect("creates");
        file.write_all(contents.as_bytes()).expect("writes");
    }

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

    fn fixture(with_updates: bool) -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path().join("sessions/%2Fw/01a07107");
        std::fs::create_dir_all(&root).expect("creates");
        write(&root.join("summary.json"), SUMMARY);
        write(
            &root.join("chat_history.jsonl"),
            &[
                r#"{"type":"system","content":"You are Grok."}"#,
                r#"{"type":"user","content":[{"type":"text","text":"Is this clean?"}]}"#,
                r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"Exploring."}],"encrypted_content":"opaque"}"#,
                r#"{"type":"assistant","content":"I'll look through the repo.","tool_calls":[{"id":"call-a","name":"list_dir","arguments":"{\"target\":\"/w\"}"}]}"#,
                r#"{"type":"tool_result","tool_call_id":"call-a","content":"README.md"}"#,
                "",
            ]
            .join("\n"),
        );
        if with_updates {
            write(
                &root.join("updates.jsonl"),
                &[
                    // The size of the context, which is not usage.
                    r#"{"timestamp":1788602706,"method":"session/update","params":{"_meta":{"totalTokens":126847}}}"#,
                    r#"{"timestamp":1788602906,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn","usage":{"inputTokens":2687582,"outputTokens":49850,"totalTokens":2737432,"cachedReadTokens":2135296,"cacheCreationTokens":0,"reasoningTokens":24859,"costUsdTicks":4201244000,"modelUsage":{"grok-4.6-build":{"inputTokens":2687582,"outputTokens":49850,"totalTokens":2737432,"cachedReadTokens":2135296,"cacheCreationTokens":0,"reasoningTokens":24859,"costUsdTicks":4201244000}}}},"_meta":{"totalTokens":126847}}}"#,
                    // Cancelled before the model answered.
                    r#"{"timestamp":1788603000,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"cancelled"}}}"#,
                    // Cancelled partway, with usage but no charge.
                    r#"{"timestamp":1788603906,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"cancelled","usage":{"modelUsage":{"grok-4.6-build":{"inputTokens":1000,"outputTokens":50,"totalTokens":1050,"cachedReadTokens":800,"cacheCreationTokens":0}},"usageIsIncomplete":true}}}}"#,
                    "",
                ]
                .join("\n"),
            );
        }
        let units = discover(&directory.path().join("sessions"));
        let unit = units.into_iter().next().expect("one session directory");
        (directory, unit)
    }

    #[test]
    fn reads_identity_and_title_from_the_summary() {
        let (_directory, source) = fixture(false);
        let session = summarize(&source).expect("summarizes").remove(0).session;

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
    }

    #[test]
    fn each_finished_turn_counts_its_usage_and_charge_when_it_finished() {
        let (_directory, source) = fixture(true);
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
    fn a_session_without_updates_reports_no_usage() {
        let (_directory, source) = fixture(false);
        let summary = summarize(&source).expect("summarizes").remove(0);
        assert!(summary.usage.is_empty());
    }

    #[test]
    fn discovery_skips_directories_with_no_summary() {
        let directory = tempfile::tempdir().expect("temp dir");
        let stray = directory.path().join("sessions/%2Fw/not-a-session");
        std::fs::create_dir_all(&stray).expect("creates");
        write(&stray.join("events.jsonl"), "{}\n");
        assert!(discover(&directory.path().join("sessions")).is_empty());
    }

    #[test]
    fn results_pair_by_id_even_when_they_arrive_out_of_order() {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path().join("sessions/%2Fw/01a07107");
        std::fs::create_dir_all(&root).expect("creates");
        write(&root.join("summary.json"), SUMMARY);
        write(
            &root.join("chat_history.jsonl"),
            &[
                r#"{"type":"assistant","content":"Working.","tool_calls":[{"id":"call-a","name":"list_dir","arguments":"{}"},{"id":"call-b","name":"read_file","arguments":"{}"}]}"#,
                // Answered second-call-first, which is what the real corpus does.
                r#"{"type":"tool_result","tool_call_id":"call-b","content":"file body"}"#,
                r#"{"type":"tool_result","tool_call_id":"call-a","content":"README.md"}"#,
                "",
            ]
            .join("\n"),
        );
        let unit = discover(&directory.path().join("sessions"))
            .into_iter()
            .next()
            .expect("one session directory");

        let read = crate::source::transcript(&unit, "01a07107").expect("reads");
        let named = |name: &str| {
            read.turns
                .iter()
                .find_map(|turn| turn.tool.as_ref().filter(|tool| tool.name == name))
                .unwrap_or_else(|| panic!("{name} is missing"))
        };
        assert_eq!(named("list_dir").output.as_deref(), Some("README.md"));
        assert_eq!(named("read_file").output.as_deref(), Some("file body"));
    }

    #[test]
    fn a_transcript_pairs_calls_attached_to_a_message() {
        let (_directory, source) = fixture(false);
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
        assert_eq!(tool.output.as_deref(), Some("README.md"));
    }
}
