//! Pi.
//!
//! One JSONL file per session under `~/.pi/agent/sessions/<slug>/`, opening
//! with a `session` record and recording usage on every assistant message. Pi's
//! usage is per message rather than cumulative, so each message's usage is
//! counted and priced when it was sent.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::{
    Conversation, Summary, Tally, Unit, compact, lines, pieces, rates, read_all, session, title_of,
    unit, walk,
};
use crate::error::Result;
use crate::session::{Agent, Session, Speaker, Tokens, ToolCall, Turn};
use crate::timestamp::parse_rfc3339;

/// One record of a session file.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Record<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: Option<&'a str>,
    timestamp: Option<&'a str>,
    cwd: Option<String>,
    provider: Option<String>,
    #[serde(rename = "modelId")]
    model_id: Option<String>,
    message: Option<Message>,
}

/// A message and the usage Pi recorded for producing it.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Message {
    role: Option<String>,
    content: Value,
    usage: Option<Usage>,
    /// Set on a `toolResult` message, naming the call it answers.
    #[serde(rename = "toolCallId")]
    tool_call_id: Option<String>,
    #[serde(rename = "isError")]
    is_error: bool,
}

/// Per-message usage, including Pi's own cost.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Usage {
    input: i64,
    output: i64,
    #[serde(rename = "cacheRead")]
    cache_read: i64,
    #[serde(rename = "cacheWrite")]
    cache_write: i64,
    #[serde(rename = "totalTokens")]
    total: i64,
    cost: Option<Cost>,
}

/// The cost Pi computed for one message.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Cost {
    total: f64,
}

/// Every session file under the sessions directory.
pub(super) fn discover(root: &Path) -> Vec<Unit> {
    let mut paths = Vec::new();
    walk(root, &mut paths);
    paths
        .into_iter()
        .filter_map(|path| unit(Agent::Pi, path))
        .collect()
}

/// Summarize a session, counting the usage it recorded on each message.
pub(super) fn summarize(source: &Unit) -> Result<Vec<Summary>> {
    let body = read_all(&source.path)?;
    let mut native_id = None;
    let mut cwd = None;
    let mut started_at = None;
    let mut updated_at = None;
    let mut title = None;
    let mut provider = String::new();
    let mut model = String::new();
    let mut tally = Tally::default();

    for line in lines(&body) {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            continue;
        };
        if let Some(at) = record.timestamp.and_then(parse_rfc3339) {
            started_at.get_or_insert(at);
            updated_at = Some(at);
        }
        match record.kind {
            "session" => {
                native_id = record.id.map(str::to_owned);
                cwd = record.cwd;
            }
            // Pi switches model mid-session, and each message's usage goes to
            // the one in force.
            "model_change" => {
                if let Some(changed) = record.model_id {
                    model = changed;
                    provider = record.provider.unwrap_or_default();
                }
            }
            "message" => {
                let Some(message) = record.message else {
                    continue;
                };
                if message.role.as_deref() == Some("user") && title.is_none() {
                    title = title_of(pieces(&message.content));
                }
                if let Some(usage) = message.usage {
                    let tokens = Tokens {
                        input: usage.input,
                        output: usage.output,
                        cache_read: usage.cache_read,
                        cache_write: usage.cache_write,
                        // Pi counts reasoning inside its output.
                        reasoning: 0,
                        total: usage.total,
                    };
                    // Pi prices from the same catalog; its own figure stands in
                    // only for a model the catalog has no price for.
                    let cost = rates(&provider, &model, &tokens)
                        .map(|rates| rates.cost(&tokens))
                        .or(usage.cost.map(|cost| cost.total));
                    let at = updated_at.unwrap_or(source.mtime);
                    tally.add(at, &provider, &model, tokens, cost);
                }
            }
            _ => {}
        }
    }

    let Some(native_id) = native_id else {
        return Ok(Vec::new());
    };
    let (started_at, updated_at) = (
        started_at.unwrap_or(source.mtime),
        updated_at.unwrap_or(source.mtime),
    );
    // Pi records no relationship between sessions, so every one of them is
    // work a person started.
    Ok(vec![tally.summary(Session {
        title,
        cwd,
        ..session(Agent::Pi, native_id, started_at, updated_at)
    })])
}

/// Read a session's conversation.
pub(super) fn transcript(source: &Unit) -> Result<Vec<Turn>> {
    let body = read_all(&source.path)?;
    let mut conversation = Conversation::default();
    let mut model = None;

    for line in lines(&body) {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            continue;
        };
        let at = record.timestamp.and_then(parse_rfc3339);
        match record.kind {
            "model_change" => model = record.model_id,
            "message" => {
                let Some(message) = record.message else {
                    continue;
                };
                let model = model.as_deref();
                let speaker = match message.role.as_deref() {
                    // A tool result is a message with its own role, not a
                    // block inside one, and it names the call it answers.
                    Some("toolResult") => {
                        if let Some(id) = message.tool_call_id.as_deref() {
                            let output = text_of(&message.content);
                            conversation.answer(id, output, message.is_error);
                        }
                        continue;
                    }
                    Some("user") => {
                        conversation.prompt(at, &text_of(&message.content));
                        continue;
                    }
                    Some("assistant") => Speaker::Assistant,
                    _ => Speaker::System,
                };
                conversation.say(speaker, at, model, text_of(&message.content));

                for block in message.content.as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("thinking") => {
                            let thinking = block["thinking"].as_str().unwrap_or_default();
                            conversation.say(Speaker::Reasoning, at, model, thinking);
                        }
                        Some("toolCall") => {
                            let tool = ToolCall {
                                name: block["name"].as_str().unwrap_or("tool").to_owned(),
                                // An object, as Pi writes it.
                                input: compact(&block["arguments"]),
                                ..ToolCall::default()
                            };
                            conversation.call(block["id"].as_str(), at, model, tool);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(conversation.into_turns())
}

/// The spoken text of a message body, with an image as a marker rather than
/// the megabytes of base64 it is recorded as.
fn text_of(content: &Value) -> String {
    match content {
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| match block["type"].as_str() {
                Some("text") => block["text"].as_str(),
                Some("image") => Some("[image]"),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => compact(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::tests::{summarized, transcribed};

    fn summary(contents: &str) -> Summary {
        summarized(Agent::Pi, contents)
    }

    const SESSION: &str = concat!(
        r#"{"type":"session","version":3,"id":"01a075c4","timestamp":"2026-09-06T08:09:52.606Z","cwd":"/Users/me/Workspace/overwatch"}"#,
        "\n",
        r#"{"type":"model_change","id":"86d4aaf7","timestamp":"2026-09-06T08:09:52.635Z","provider":"xai","modelId":"grok-4.6"}"#,
        "\n",
        r#"{"type":"message","id":"b1a","timestamp":"2026-09-06T08:09:58.622Z","message":{"role":"user","content":[{"type":"text","text":"What do you think of this?"}]}}"#,
        "\n",
        r#"{"type":"message","id":"280","timestamp":"2026-09-06T08:10:01.067Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Considering."},{"type":"text","text":"Here is my view."},{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls"}}],"usage":{"input":1689,"output":150,"cacheRead":640,"cacheWrite":0,"reasoning":69,"totalTokens":2479,"cost":{"input":0.003378,"output":0.0009,"total":0.004598}}}}"#,
        "\n",
        r#"{"type":"message","id":"281","timestamp":"2026-09-06T08:10:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":10,"output":5,"cacheRead":1,"cacheWrite":2,"reasoning":3,"totalTokens":21,"cost":{"total":0.0001}}}}"#,
        "\n",
    );

    #[test]
    fn per_message_usage_is_summed_across_the_session() {
        let tokens = summary(SESSION).tokens();

        // Pi reports per message, so unlike Codex these must be added.
        assert_eq!(tokens.input, 1_699);
        assert_eq!(tokens.output, 155);
        assert_eq!(tokens.cache_read, 641);
        assert_eq!(tokens.cache_write, 2);
        // Pi states its own total per message; both are added, not recomputed.
        assert_eq!(tokens.total, 2_500);
    }

    #[test]
    fn usage_is_priced_and_pis_own_cost_stands_in_for_an_unpriced_model() {
        let cost = |session: &str| summary(session).cost().expect("a cost");
        // At xAI's $2, $6 and $0.50 per million, the first message costs the
        // $0.004598 Pi recorded for it, and the second $0.0000545.
        let priced = cost(SESSION);
        assert!((priced - 0.004_652_5).abs() < 1e-12, "got {priced}");
        // Pi's own $0.004598 and $0.0001.
        let unpriced = cost(&SESSION.replace("grok-4.6", "no-such-model"));
        assert!((unpriced - 0.004_698).abs() < 1e-12, "got {unpriced}");
    }

    #[test]
    fn a_model_is_priced_by_its_id_and_counted_under_its_name() {
        // Through OpenRouter, Pi records the model with its vendor in front.
        let summary = summary(&SESSION.replace(
            r#""provider":"xai","modelId":"grok-4.6""#,
            r#""provider":"openrouter","modelId":"google/gemini-3.8-flash""#,
        ));

        // The name OpenCode gives the same model, so the two count as one.
        assert_eq!(summary.models(), [("gemini-3.8-flash", 2_500)]);
        // At OpenRouter's $0.75, $3.75, $0.075 and $0.041667 per million
        // input, output, cache-read and cache-write tokens, the messages cost
        // $0.00187725 and $0.000026408334. The catalog lists the model only by
        // its id, so pricing it by name would have fallen back to Pi's own
        // $0.004698.
        let cost = summary.cost().expect("a cost");
        assert!((cost - 0.001_903_658_334).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn reads_identity_title_and_model() {
        let summary = summary(SESSION);
        let session = &summary.session;
        assert_eq!(session.id, "pi:01a075c4");
        assert_eq!(
            session.cwd.as_deref(),
            Some("/Users/me/Workspace/overwatch")
        );
        assert_eq!(session.title.as_deref(), Some("What do you think of this?"));
        // All of it under the one model in force.
        assert_eq!(summary.models(), [("grok-4.6", 2_500)]);
        assert_eq!(session.started_at, 1_788_682_192_606);
        assert_eq!(session.updated_at, 1_788_682_205_000);
    }

    #[test]
    fn a_session_with_no_usage_reports_no_cost() {
        let summary = summary(concat!(
            r#"{"type":"session","id":"bare-1","timestamp":"2026-09-06T08:09:52.606Z","cwd":"/w"}"#,
            "\n",
            r#"{"type":"message","id":"m","timestamp":"2026-09-06T08:09:58.622Z","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}"#,
            "\n",
        ));
        assert_eq!(summary.cost(), None, "no cost recorded is not zero cost");
        assert!(summary.usage.is_empty());
    }

    #[test]
    fn a_transcript_separates_thinking_speech_and_tools() {
        let read = transcribed(Agent::Pi, SESSION);
        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(
            speakers,
            [
                Speaker::User,
                Speaker::Assistant,
                Speaker::Reasoning,
                Speaker::Tool,
                Speaker::Assistant
            ]
        );
        assert_eq!(read.messages, 3);
        assert_eq!(read.tools, 1);
        let tool = read.turns[3].tool.as_ref().expect("a tool call");
        assert_eq!(tool.name, "bash");
        // Pi writes arguments as an object; reading them only as text lost
        // every call's input.
        assert_eq!(tool.input, r#"{"command":"ls"}"#);
    }

    #[test]
    fn tool_results_are_messages_of_their_own_and_pair_by_id() {
        // Pi records a result as a message whose *role* is `toolResult`, not
        // as a block inside another message, and answers concurrent calls in
        // whatever order they finish.
        let read = transcribed(
            Agent::Pi,
            concat!(
                r#"{"type":"session","id":"tr-1","timestamp":"2026-09-06T08:09:52.606Z","cwd":"/w"}"#,
                "\n",
                r#"{"type":"message","id":"a","timestamp":"2026-09-06T08:10:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-A","name":"bash","arguments":{}},{"type":"toolCall","id":"call-B","name":"read","arguments":{}}]}}"#,
                "\n",
                r#"{"type":"message","id":"b","timestamp":"2026-09-06T08:10:02.000Z","message":{"role":"toolResult","toolCallId":"call-B","toolName":"read","content":[{"type":"text","text":"file body"}]}}"#,
                "\n",
                r#"{"type":"message","id":"c","timestamp":"2026-09-06T08:10:03.000Z","message":{"role":"toolResult","toolCallId":"call-A","toolName":"bash","isError":true,"content":[{"type":"text","text":"command failed"}]}}"#,
                "\n",
            ),
        );

        // Two calls, and no extra turn for either result.
        assert_eq!(read.tools, 2);
        let speakers: Vec<_> = read.turns.iter().map(|turn| turn.speaker).collect();
        assert_eq!(speakers, [Speaker::Tool, Speaker::Tool]);

        let bash = read.turns[0].tool.as_ref().expect("the first call");
        assert_eq!(bash.name, "bash");
        assert_eq!(bash.output.as_deref(), Some("command failed"));
        assert!(bash.failed, "the result said so");

        let read_tool = read.turns[1].tool.as_ref().expect("the second call");
        assert_eq!(read_tool.name, "read");
        // Answered first despite being called second; matching by position
        // rather than by id would have swapped these two outputs.
        assert_eq!(read_tool.output.as_deref(), Some("file body"));
        assert!(!read_tool.failed);
    }

    #[test]
    fn image_payloads_do_not_become_transcript_text() {
        // A base64 image would otherwise put megabytes of noise on screen.
        let content = serde_json::json!([
            {"type":"text","text":"Look:"},
            {"type":"image","data":"iVBORw0KGgoAAAANS","mimeType":"image/png"}
        ]);
        assert_eq!(text_of(&content), "Look:\n[image]");
    }
}
