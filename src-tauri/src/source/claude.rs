//! Claude Code.
//!
//! One JSONL file per session under `~/.claude/projects/<slug>/`, and one per
//! subagent run under `<slug>/<session>/subagents/`. A subagent's records carry
//! its parent's `sessionId`, so its own `agentId` is what identifies it.
//!
//! A response is written one line per content block, and each line repeats the
//! response's `usage` as it stood when that block was written, so a response is
//! counted once, from its last line, and priced then. Claude Code's own
//! `cost-state` is only a running total for the whole session, which says
//! nothing about when or on which response the money went. An `ai-title`
//! record holds a generated name, rewritten as the conversation develops, so
//! the last one is the current title.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::error::Result;
use crate::price;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::source::{
    Conversation, Summary, Tally, Unit, compact, lines, pieces, prompt_parts, read_all, title_of,
    unit, walk,
};

/// A record as the conversation reader sees it.
#[derive(Deserialize)]
struct Record<'a> {
    #[serde(rename = "type", default)]
    kind: &'a str,
    #[serde(default)]
    timestamp: Option<&'a str>,
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: bool,
    #[serde(default)]
    message: Option<Message>,
}

/// A message body, whose `content` is either plain text or a block list.
#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    content: Value,
}

/// A record as a summary reads it.
///
/// Every field is optional, so an unfamiliar record deserializes without
/// failing and contributes nothing, and message bodies stay unparsed.
#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(rename = "type", default)]
    kind: &'a str,
    #[serde(rename = "sessionId", default)]
    session_id: Option<&'a str>,
    #[serde(rename = "agentId", default)]
    agent_id: Option<&'a str>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(rename = "gitBranch", default)]
    branch: Option<String>,
    #[serde(default)]
    timestamp: Option<&'a str>,
    #[serde(rename = "requestId", default)]
    request_id: Option<&'a str>,
    #[serde(rename = "aiTitle", default)]
    ai_title: Option<String>,
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: bool,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: bool,
    #[serde(default, borrow)]
    message: Option<Reply<'a>>,
}

/// A message as a summary reads it.
#[derive(Deserialize)]
struct Reply<'a> {
    #[serde(default)]
    id: Option<&'a str>,
    #[serde(default)]
    model: Option<&'a str>,
    #[serde(default, borrow)]
    content: Option<&'a RawValue>,
    #[serde(default)]
    usage: Option<Usage>,
}

/// What one response used.
#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
    #[serde(default)]
    cache_creation: Option<Creation>,
}

/// How a response's cache writes divide by how long they are kept.
#[derive(Deserialize)]
struct Creation {
    #[serde(default)]
    ephemeral_1h_input_tokens: i64,
}

impl Usage {
    /// The response's tokens. Thinking is counted inside the output, and not
    /// reported apart.
    fn tokens(&self) -> Tokens {
        Tokens {
            input: self.input_tokens,
            output: self.output_tokens,
            cache_read: self.cache_read_input_tokens,
            cache_write: self.cache_creation_input_tokens,
            reasoning: 0,
            total: self.input_tokens
                + self.output_tokens
                + self.cache_read_input_tokens
                + self.cache_creation_input_tokens,
        }
    }

    /// What the response cost at Anthropic's list prices for `model`.
    ///
    /// The catalog prices cache writes kept for five minutes; Anthropic bills a
    /// write kept for an hour at twice the input rate.
    fn cost(&self, model: &str) -> Option<f64> {
        let tokens = self.tokens();
        let context = tokens.input + tokens.cache_read + tokens.cache_write;
        let rates = price::rates("anthropic", model, context)?;
        let hour = self
            .cache_creation
            .as_ref()
            .map_or(0, |creation| creation.ephemeral_1h_input_tokens);
        Some(rates.cost(&tokens) + hour as f64 * (2.0 * rates.input - rates.cache_write) / 1e6)
    }
}

/// Every session file under the projects directory.
pub fn discover(root: &Path) -> Vec<Unit> {
    let mut paths = Vec::new();
    walk(root, "jsonl", &mut paths);
    paths
        .into_iter()
        .filter_map(|path| unit(Agent::ClaudeCode, path))
        .collect()
}

/// Summarize a session, counting each response once.
pub fn summarize(source: &Unit) -> Result<Vec<Summary>> {
    let body = read_all(&source.path)?;
    let mut session_id = None;
    let mut agent_id = None;
    let mut cwd = None;
    let mut branch = None;
    let mut started_at = None;
    let mut updated_at = None;
    let mut ai_title = None;
    let mut prompt_title = None;
    let mut spawned = false;
    let mut inherited = false;
    // Each response as its last line left it, by message and request.
    let mut responses: HashMap<(&str, &str), (i64, &str, Usage)> = HashMap::new();
    let mut tally = Tally::default();

    for line in lines(&body) {
        let Ok(entry) = serde_json::from_slice::<Entry>(line) else {
            continue;
        };
        session_id = session_id.or(entry.session_id);
        agent_id = agent_id.or(entry.agent_id);
        cwd = cwd.or(entry.cwd);
        branch = branch.or(entry.branch);
        if let Some(at) = entry.timestamp.and_then(crate::timestamp::parse_rfc3339) {
            started_at.get_or_insert(at);
            updated_at = Some(at);
        }
        spawned |= entry.is_sidechain;

        inherited &= entry.kind != "user";
        match entry.kind {
            "ai-title" => ai_title = entry.ai_title,
            // A fork opens with a copy of the parent's response that started
            // it, which is the parent's usage rather than the fork's.
            "fork-context-ref" => inherited = true,
            "user" if !entry.is_meta && !entry.is_compact_summary && prompt_title.is_none() => {
                if let Some(content) = entry.message.and_then(|message| message.content)
                    && let Ok(content) = serde_json::from_str::<Value>(content.get())
                {
                    prompt_title = title_of(pieces(&content));
                }
            }
            "assistant" if !inherited => {
                let Some(message) = entry.message else {
                    continue;
                };
                let Some(usage) = message.usage else {
                    continue;
                };
                let at = updated_at.unwrap_or(source.mtime);
                let model = message.model.unwrap_or_default();
                match message.id {
                    Some(id) => {
                        let request = entry.request_id.unwrap_or_default();
                        responses.insert((id, request), (at, model, usage));
                    }
                    None => tally.add(at, "anthropic", model, usage.tokens(), usage.cost(model)),
                }
            }
            _ => {}
        }
    }

    let Some(session_id) = session_id else {
        return Ok(Vec::new());
    };
    for (at, model, usage) in responses.into_values() {
        tally.add(at, "anthropic", model, usage.tokens(), usage.cost(model));
    }

    let native_id = agent_id.unwrap_or(session_id).to_owned();
    let session = Session {
        id: format!("{}:{native_id}", Agent::ClaudeCode.key()),
        agent: Agent::ClaudeCode,
        native_id,
        title: ai_title.or(prompt_title),
        cwd,
        branch,
        started_at: started_at.unwrap_or(source.mtime),
        updated_at: updated_at.unwrap_or(source.mtime),
        spawned,
        role: None,
        models: Vec::new(),
        tokens: Tokens::default(),
        cost_usd: None,
        messages: None,
        tools: None,
        present: true,
    };
    Ok(vec![tally.summary(session)])
}

/// Read a session's conversation.
pub fn transcript(source: &Unit) -> Result<Vec<Turn>> {
    let body = read_all(&source.path)?;
    let mut conversation = Conversation::default();

    for line in lines(&body) {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            continue;
        };
        if record.kind != "user" && record.kind != "assistant" {
            continue;
        }
        let Some(message) = record.message else {
            continue;
        };
        let at = record.timestamp.and_then(crate::timestamp::parse_rfc3339);
        let model = message.model.as_deref();
        let blocks = message
            .content
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();

        // A result names the call it answers, so it is folded into that call
        // rather than shown as a message of its own.
        for block in blocks.iter().filter(|block| block["type"] == "tool_result") {
            if let Some(id) = block["tool_use_id"].as_str() {
                let failed = block["is_error"].as_bool().unwrap_or(false);
                conversation.answer(id, text_of(&block["content"]), failed);
            }
        }

        if message.role.as_deref() == Some("assistant") {
            conversation.say(Speaker::Assistant, at, model, text_of(&message.content));
        } else if record.is_meta || record.is_compact_summary {
            // Claude Code's own additions, such as a skill's instructions or
            // the summary a compacted conversation carries on from.
            for (_, part) in pieces(&message.content).into_iter().flat_map(prompt_parts) {
                conversation.say(Speaker::System, at, None, part);
            }
        } else {
            for piece in pieces(&message.content) {
                conversation.prompt(at, piece);
            }
        }

        for block in blocks {
            match block["type"].as_str() {
                Some("thinking") => {
                    let thinking = block["thinking"].as_str().unwrap_or_default();
                    conversation.say(Speaker::Reasoning, at, model, thinking);
                }
                Some("tool_use") => {
                    let tool = ToolCall {
                        name: block["name"].as_str().unwrap_or("tool").to_owned(),
                        input: compact(&block["input"]),
                        ..ToolCall::default()
                    };
                    conversation.call(block["id"].as_str(), at, model, tool);
                }
                _ => {}
            }
        }
    }
    Ok(conversation.into_turns())
}

/// Flatten a message body into the text a reader sees.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => {
            let mut text = String::new();
            for block in blocks {
                // Thinking and tool calls become turns of their own; only
                // spoken text belongs in the message body.
                if block["type"] == "text"
                    && let Some(part) = block["text"].as_str()
                {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(part);
                }
            }
            text
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(contents: &str) -> (tempfile::TempDir, Unit) {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).expect("creates");
        file.write_all(contents.as_bytes()).expect("writes");
        let source = unit(Agent::ClaudeCode, path).expect("unit");
        (directory, source)
    }

    fn summary(contents: &str) -> Summary {
        let (_directory, source) = fixture(contents);
        summarize(&source).expect("summarizes").remove(0)
    }

    /// A closed session: a response written over two lines, with part of what
    /// it cached kept for an hour, and another a quarter hour later.
    const CLOSED: &str = concat!(
        r#"{"type":"mode","mode":"normal","sessionId":"abc-123"}"#,
        "\n",
        r#"{"type":"user","message":{"role":"user","content":"Fix the parser"},"timestamp":"2026-09-11T23:38:22.696Z","cwd":"/w/proj","sessionId":"abc-123","gitBranch":"main"}"#,
        "\n",
        r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"thinking","thinking":"Looking."}],"usage":{"input_tokens":2,"output_tokens":10,"cache_read_input_tokens":600,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}},"timestamp":"2026-09-11T23:38:45.739Z","sessionId":"abc-123"}"#,
        "\n",
        r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"On it."}],"usage":{"input_tokens":2,"output_tokens":98,"cache_read_input_tokens":600,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}},"timestamp":"2026-09-11T23:38:46.000Z","sessionId":"abc-123"}"#,
        "\n",
        r#"{"type":"assistant","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":10,"output_tokens":190,"cache_read_input_tokens":2800,"cache_creation_input_tokens":0}},"timestamp":"2026-09-11T23:52:00.000Z","sessionId":"abc-123"}"#,
        "\n",
        r#"{"type":"ai-title","aiTitle":"Parser repair","sessionId":"abc-123"}"#,
        "\n",
    );

    #[test]
    fn reads_identity_title_and_timestamps() {
        let session = summary(CLOSED).session;
        assert_eq!(session.id, "claude_code:abc-123");
        assert_eq!(session.native_id, "abc-123");
        assert_eq!(session.cwd.as_deref(), Some("/w/proj"));
        assert_eq!(session.branch.as_deref(), Some("main"));
        // The generated title wins over the opening prompt.
        assert_eq!(session.title.as_deref(), Some("Parser repair"));
        assert!(!session.spawned);
        // Independently known: 2026-09-11T23:38:22.696Z and 23:52:00Z.
        assert_eq!(session.started_at, 1_789_169_902_696);
        assert_eq!(session.updated_at, 1_789_170_720_000);
    }

    #[test]
    fn each_response_counts_once_from_its_last_line() {
        let tokens = summary(CLOSED).tokens();
        // 1_000 for the response written over two lines, not 1_912, and 3_000.
        assert_eq!(tokens.total, 4_000);
        assert_eq!(tokens.output, 288);
        assert_eq!(tokens.cache_read, 3_400);
        assert_eq!(tokens.cache_write, 300);
    }

    #[test]
    fn each_response_is_priced_when_it_happened() {
        let costs: Vec<_> = summary(CLOSED)
            .usage
            .iter()
            .map(|usage| usage.cost_usd.expect("priced"))
            .collect();
        // Opus at $5, $25, $0.50 and $6.25 per million for input, output, cache
        // reads and cache writes, and $10 for the 200 tokens kept for an hour:
        // 10 + 2_450 + 300 + 625 + 2_000 millionths, then 50 + 4_750 + 1_400.
        assert_eq!(costs.len(), 2);
        assert!((costs[0] - 0.005_385).abs() < 1e-12, "got {costs:?}");
        assert!((costs[1] - 0.006_2).abs() < 1e-12, "got {costs:?}");
    }

    #[test]
    fn a_running_session_counts_the_responses_so_far() {
        // No title yet: this is what a session still in progress looks like.
        let running = concat!(
            r#"{"type":"user","message":{"role":"user","content":"Hello there"},"timestamp":"2026-09-11T23:38:22.696Z","sessionId":"live-1","cwd":"/w"}"#,
            "\n",
            r#"{"type":"assistant","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"timestamp":"2026-09-11T23:38:30.000Z","sessionId":"live-1"}"#,
            "\n",
            r#"{"type":"assistant","requestId":"req_2","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"More"}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}},"timestamp":"2026-09-11T23:38:40.000Z","sessionId":"live-1"}"#,
            "\n",
        );
        let summary = summary(running);
        let tokens = summary.tokens();

        assert_eq!(tokens.input, 11);
        assert_eq!(tokens.output, 7);
        assert_eq!(tokens.cache_read, 103);
        assert_eq!(tokens.cache_write, 24);
        assert_eq!(tokens.total, 145);
        // With no generated title the opening prompt names the session.
        assert_eq!(summary.session.title.as_deref(), Some("Hello there"));
    }

    #[test]
    fn a_fork_does_not_count_the_parents_response_it_opens_with() {
        let fork = concat!(
            r#"{"type":"fork-context-ref"}"#,
            "\n",
            r#"{"type":"assistant","isSidechain":true,"agentId":"f1","requestId":"req_p","message":{"id":"msg_p","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","name":"Agent"}],"usage":{"input_tokens":5,"output_tokens":50,"cache_read_input_tokens":9000,"cache_creation_input_tokens":0}},"timestamp":"2026-09-11T23:40:00.000Z","sessionId":"abc-123"}"#,
            "\n",
            r#"{"type":"user","isSidechain":true,"agentId":"f1","message":{"role":"user","content":[{"type":"tool_result","content":"Forked."}]},"timestamp":"2026-09-11T23:40:01.000Z","sessionId":"abc-123"}"#,
            "\n",
            r#"{"type":"assistant","isSidechain":true,"agentId":"f1","requestId":"req_f","message":{"id":"msg_f","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Found it."}],"usage":{"input_tokens":3,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-09-11T23:40:05.000Z","sessionId":"abc-123"}"#,
            "\n",
        );
        let summary = summary(fork);
        assert_eq!(summary.session.native_id, "f1");
        // Only the fork's own response: the 9_055 tokens before it are the
        // parent's, and its own file counts them.
        assert_eq!(summary.tokens().total, 10);
    }

    #[test]
    fn a_subagent_run_is_a_spawned_session_of_its_own() {
        // Its records name the parent's session; the agent id is its own.
        let run = concat!(
            r#"{"type":"user","isSidechain":true,"agentId":"a8f3c2d19e4b7a650","message":{"role":"user","content":"Find the parser"},"timestamp":"2026-09-11T23:40:00.000Z","sessionId":"abc-123"}"#,
            "\n",
        );
        let session = summary(run).session;
        assert_eq!(session.id, "claude_code:a8f3c2d19e4b7a650");
        assert!(session.spawned);
    }

    #[test]
    fn meta_messages_do_not_become_titles() {
        let with_meta = concat!(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: local command"},"timestamp":"2026-09-11T23:38:22.696Z","sessionId":"m-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"The actual request"},"timestamp":"2026-09-11T23:38:23.000Z","sessionId":"m-1"}"#,
            "\n",
        );
        let session = summary(with_meta).session;
        assert_eq!(session.title.as_deref(), Some("The actual request"));
    }

    #[test]
    fn a_file_with_no_session_id_yields_nothing() {
        let (_directory, source) = fixture("{\"type\":\"mode\"}\n");
        assert!(summarize(&source).expect("summarizes").is_empty());
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let broken = concat!(
            "not json at all\n",
            r#"{"type":"user","message":{"role":"user","content":"Still read"},"timestamp":"2026-09-11T23:38:22.696Z","sessionId":"b-1"}"#,
            "\n{\"truncated\": \n",
        );
        let session = summary(broken).session;
        assert_eq!(session.native_id, "b-1");
        assert_eq!(session.title.as_deref(), Some("Still read"));
    }

    #[test]
    fn a_transcript_pairs_tool_calls_with_their_results() {
        let conversation = concat!(
            r#"{"type":"user","message":{"role":"user","content":"Read the file"},"timestamp":"2026-09-11T23:38:22.696Z","sessionId":"t-1"}"#,
            "\n",
            r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"thinking","thinking":"I should read it."},{"type":"text","text":"Reading now."},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"/tmp/x"}}]},"timestamp":"2026-09-11T23:38:30.000Z","sessionId":"t-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents","is_error":false}]},"timestamp":"2026-09-11T23:38:31.000Z","sessionId":"t-1"}"#,
            "\n",
        );
        let (_directory, source) = fixture(conversation);
        let read = crate::source::transcript(&source, "t-1").expect("reads");

        assert_eq!(read.tools, 1);
        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::User,
                Speaker::Assistant,
                Speaker::Reasoning,
                Speaker::Tool
            ]
        );
        assert_eq!(read.turns[0].text, "Read the file");
        assert_eq!(read.turns[1].text, "Reading now.");
        assert_eq!(read.turns[2].text, "I should read it.");

        let tool = read.turns[3].tool.as_ref().expect("a tool call");
        // The real name replaces the id placeholder once the result pairs.
        assert_eq!(tool.name, "Read");
        assert_eq!(tool.output.as_deref(), Some("file contents"));
        assert!(!tool.failed);
        assert!(tool.input.contains("/tmp/x"));
    }

    #[test]
    fn what_claude_code_adds_reads_as_context_rather_than_as_the_person() {
        let conversation = concat!(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: ignore these.</local-command-caveat>"},"timestamp":"2026-09-11T23:38:20.000Z","sessionId":"h-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus</command-args>"},"timestamp":"2026-09-11T23:38:21.000Z","sessionId":"h-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to Opus</local-command-stdout>"},"timestamp":"2026-09-11T23:38:21.500Z","sessionId":"h-1"}"#,
            "\n",
            r#"{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued."},"timestamp":"2026-09-11T23:38:22.000Z","sessionId":"h-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the parser"}]},"timestamp":"2026-09-11T23:38:23.000Z","sessionId":"h-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"},"timestamp":"2026-09-11T23:38:24.000Z","sessionId":"h-1"}"#,
            "\n",
        );
        let (_directory, source) = fixture(conversation);
        let read = crate::source::transcript(&source, "h-1").expect("reads");
        let turns: Vec<_> = read
            .turns
            .iter()
            .map(|turn| (turn.speaker, turn.text.as_str()))
            .collect();
        assert_eq!(
            turns,
            [
                (Speaker::User, "/model opus"),
                (Speaker::System, "Set model to Opus"),
                (Speaker::System, "This session is being continued."),
                (Speaker::User, "Fix the parser"),
                (Speaker::System, "[Request interrupted by user]"),
            ]
        );
        // Neither the command nor the summary names the session.
        assert_eq!(
            summary(conversation).session.title.as_deref(),
            Some("Fix the parser")
        );
    }

    #[test]
    fn a_failed_tool_result_is_marked() {
        let failing = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"cmd":"false"}}]},"timestamp":"2026-09-11T23:38:30.000Z","sessionId":"f-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"exit 1","is_error":true}]},"timestamp":"2026-09-11T23:38:31.000Z","sessionId":"f-1"}"#,
            "\n",
        );
        let (_directory, source) = fixture(failing);
        let read = crate::source::transcript(&source, "t-1").expect("reads");
        let tool = read.turns[0].tool.as_ref().expect("a tool call");
        assert_eq!(tool.name, "Bash");
        assert!(tool.failed);
    }

    #[test]
    fn an_unanswered_tool_call_keeps_its_name() {
        let unanswered = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_77","name":"Write","input":{}}]},"timestamp":"2026-09-11T23:38:30.000Z","sessionId":"u-1"}"#,
            "\n",
        );
        let (_directory, source) = fixture(unanswered);
        let read = crate::source::transcript(&source, "t-1").expect("reads");
        let tool = read.turns[0].tool.as_ref().expect("a tool call");
        assert_eq!(tool.name, "Write");
        assert_eq!(tool.output, None);
    }

    #[test]
    fn concurrent_tool_calls_pair_by_id_not_by_position() {
        // One assistant turn making three calls, answered out of order with
        // one never answered at all. Matching by position would mis-attribute
        // every output here.
        let conversation = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{}},{"type":"tool_use","id":"toolu_B","name":"Read","input":{}},{"type":"tool_use","id":"toolu_C","name":"Write","input":{}}]},"timestamp":"2026-09-11T23:38:30.000Z","sessionId":"c-1"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_C","content":"wrote it"},{"type":"tool_result","tool_use_id":"toolu_A","content":"ran it","is_error":true}]},"timestamp":"2026-09-11T23:38:31.000Z","sessionId":"c-1"}"#,
            "\n",
        );
        let (_directory, source) = fixture(conversation);
        let read = crate::source::transcript(&source, "t-1").expect("reads");

        assert_eq!(read.tools, 3);
        let named = |name: &str| {
            read.turns
                .iter()
                .find_map(|turn| turn.tool.as_ref().filter(|tool| tool.name == name))
                .unwrap_or_else(|| panic!("{name} is missing"))
        };
        assert_eq!(named("Bash").output.as_deref(), Some("ran it"));
        assert!(named("Bash").failed);
        assert_eq!(named("Write").output.as_deref(), Some("wrote it"));
        assert!(!named("Write").failed);
        // Never answered: no output, and it keeps its real name rather than
        // showing the call identifier.
        assert_eq!(named("Read").output, None);
    }

    #[test]
    fn string_and_block_contents_both_read_as_text() {
        assert_eq!(text_of(&serde_json::json!("plain")), "plain");
        assert_eq!(
            text_of(&serde_json::json!([
                {"type":"text","text":"one"},
                {"type":"thinking","thinking":"hidden"},
                {"type":"text","text":"two"}
            ])),
            "one\ntwo"
        );
        assert_eq!(text_of(&Value::Null), "");
    }
}
