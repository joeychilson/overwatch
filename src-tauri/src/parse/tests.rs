use super::*;
use serde_json::json;
use std::io::Write;

fn log(agent: Agent, records: &[Value]) -> Result<(tempfile::NamedTempFile, Cursor)> {
    let mut file = tempfile::NamedTempFile::new()?;
    for record in records {
        writeln!(file, "{record}")?;
    }
    let mut cursor = Cursor::new(agent, file.path(), true);
    cursor.read(file.path())?;
    Ok((file, cursor))
}
#[test]
fn codex_precise_records_preserve_earlier_usage_and_deduplicate_response_ids() -> Result<()> {
    let (_, cursor) = log(
        Agent::Codex,
        &[
            json!({"type":"turn_context","payload":{"model":"test-model"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000},"last_token_usage":{"input_tokens":1000}}}}),
            json!({"type":"token_usage_record","payload":{"response_id":"r","usage":{"input_tokens":80,"cached_input_tokens":30,"output_tokens":20,"reasoning_output_tokens":6}}}),
            json!({"type":"token_usage_record","payload":{"response_id":"r","usage":{"input_tokens":80,"cached_input_tokens":30,"output_tokens":20,"reasoning_output_tokens":6}}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":80,"cached_input_tokens":30,"output_tokens":20},"last_token_usage":{"input_tokens":80,"cached_input_tokens":30,"output_tokens":20}}}}),
        ],
    )?;
    let summary = cursor.summary();
    assert_eq!(summary.tokens.total(), 1100);
    assert_eq!(summary.tokens.input, 1050);
    assert_eq!(summary.tokens.reasoning, 6);
    assert_eq!(summary.usage.len(), 2);
    // Missing dates remain explicitly unknown; usage is still retained.
    assert_eq!(summary.usage[0].timestamp, 0);
    Ok(())
}
#[test]
fn inherited_codex_counter_is_a_baseline() -> Result<()> {
    let (_, cursor) = log(
        Agent::Codex,
        &[
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":900}}}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":940,"output_tokens":10}}}}),
        ],
    )?;
    assert_eq!(cursor.summary().tokens.total(), 50);
    Ok(())
}
#[test]
fn codex_spark_limits_do_not_replace_or_add_to_account_allowances() -> Result<()> {
    let (_, cursor) = log(
        Agent::Codex,
        &[
            json!({"timestamp":1_800_000_000_000i64,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42,"window_minutes":300}}}}),
            json!({"timestamp":1_800_000_000_001i64,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex_spark","primary":{"used_percent":0,"window_minutes":300}}}}),
            json!({"timestamp":1_800_000_000_002i64,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limitId":"GPT-5.3-Codex-Spark","secondary":{"usedPercent":0,"windowDurationMins":10080}}}}),
            json!({"timestamp":1_800_000_000_003i64,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex_bengalfox","primary":{"used_percent":0,"window_minutes":300}}}}),
        ],
    )?;
    let session = cursor.summary();
    assert_eq!(session.limits.len(), 1);
    assert_eq!(session.limits[0].bucket, "codex:primary");
    assert_eq!(session.limits[0].used_percent, 42.0);
    Ok(())
}
#[test]
fn incomplete_lines_wait_and_rewrites_invalidate_the_cursor() -> Result<()> {
    let mut file = tempfile::NamedTempFile::new()?;
    let record = json!({"type":"message","id":"a","message":{"role":"user","content":"First"}});
    write!(file, "{record}")?;
    let mut cursor = Cursor::new(Agent::Pi, file.path(), true);
    cursor.read(file.path())?;
    assert!(cursor.data.events.is_empty());
    writeln!(file)?;
    cursor.read(file.path())?;
    assert_eq!(cursor.data.events.len(), 1);
    std::fs::write(
        file.path(),
        format!(
            "{}\n",
            json!({"type":"message","id":"b","message":{"role":"user","content":"Replacement is longer"}})
        ),
    )?;
    cursor.read(file.path())?;
    assert_eq!(cursor.data.events.len(), 1);
    assert_eq!(cursor.data.events[0].text, "Replacement is longer");

    let first =
        json!({"type":"message","id":"first","message":{"role":"user","content":"Original value"}});
    let replacement =
        json!({"type":"message","id":"first","message":{"role":"user","content":"Replaced value"}});
    let tail = json!({"type":"message","id":"tail","message":{"role":"user","content":"Stable tail ".repeat(20)}});
    std::fs::write(file.path(), format!("{first}\n{tail}\n"))?;
    cursor.read(file.path())?;
    assert_eq!(cursor.data.events[0].text, "Original value");
    let rewritten = format!("{replacement}\n{tail}\n");
    assert_eq!(
        rewritten.len(),
        std::fs::metadata(file.path())?.len() as usize
    );
    std::fs::write(file.path(), rewritten)?;
    cursor.read(file.path())?;
    assert_eq!(cursor.data.events[0].text, "Replaced value");
    Ok(())
}
#[test]
fn claude_streaming_usage_and_tools_have_independent_identities() -> Result<()> {
    let (_, cursor) = log(
        Agent::Claude,
        &[
            json!({"uuid":"a","timestamp":1700000000000i64,"type":"assistant","message":{"id":"msg","model":"claude-test","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":30},"content":[{"type":"tool_use","id":"call","name":"mcp__repo__read","input":{"path":"file"}}]}}),
            json!({"uuid":"b","timestamp":1700000000200i64,"type":"assistant","message":{"id":"msg","usage":{"input_tokens":20,"output_tokens":10,"cache_read_input_tokens":30},"content":[{"type":"text","text":"Finished"}]}}),
            json!({"uuid":"c","timestamp":1700000001000i64,"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","is_error":true,"content":"Recorded failure"}]}}),
        ],
    )?;
    let summary = cursor.summary();
    assert_eq!(summary.tokens.total(), 60);
    assert_eq!(summary.tools[0].calls, 1);
    assert_eq!(summary.tools[0].failures, 1);
    assert_eq!(summary.tools[0].duration_ms, 1000);
    Ok(())
}
#[test]
fn pi_preserves_free_reported_cost_and_compaction_text() -> Result<()> {
    let (_, cursor) = log(
        Agent::Pi,
        &[
            json!({"id":"a","type":"message","message":{"role":"assistant","provider":"example","model":"model","content":[{"type":"text","text":"Hello"}],"usage":{"input":50,"output":15,"cacheRead":10,"cacheWrite":5,"cost":{"total":0}}}}),
            json!({"id":"b","type":"compaction","summary":"Kept the important context"}),
        ],
    )?;
    let summary = cursor.summary();
    assert_eq!(summary.tokens.total(), 80);
    assert_eq!(summary.usage[0].reported_cost, Some(0.0));
    assert_eq!(summary.compactions, 1);
    assert_eq!(cursor.data.events[1].text, "Kept the important context");
    Ok(())
}
#[test]
fn grok_chunks_coalesce_and_prompt_usage_is_normalized() -> Result<()> {
    let (_, cursor) = log(
        Agent::Grok,
        &[
            json!({"params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Hello "}}}}),
            json!({"params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"world"}}}}),
            json!({"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"modelUsage":{"grok-test":{"inputTokens":80,"cachedReadTokens":20,"cacheCreationTokens":10,"outputTokens":15,"reasoningTokens":5}}}}}}),
        ],
    )?;
    assert_eq!(cursor.data.events.len(), 1);
    assert_eq!(cursor.data.events[0].text, "Hello world");
    assert_eq!(cursor.summary().tokens.total(), 95);
    assert_eq!(cursor.summary().tokens.input, 50);
    Ok(())
}
#[test]
fn malformed_records_are_visible_and_absent_failures_stay_unknown() -> Result<()> {
    let (mut file, mut cursor) = log(
        Agent::Codex,
        &[
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"tool","arguments":"{}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"Looks okay"}}),
        ],
    )?;
    writeln!(file, "malformed")?;
    cursor.read(file.path())?;
    assert_eq!(cursor.data.events[0].failed, None);
    assert_eq!(cursor.summary().warnings.len(), 1);
    Ok(())
}
