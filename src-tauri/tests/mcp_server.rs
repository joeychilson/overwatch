//! The MCP server as an agent starts it: the app's own executable run as
//! `overwatch mcp`, speaking JSON-RPC a line at a time on standard input and
//! output, and its tools run once as `overwatch call`, as a shell loop or a
//! hook runs them. Both read the index the app keeps for the user they run as.

use std::io::Write;
use std::process::{Command, Output, Stdio};

use overwatch_lib::index::Index;
use serde_json::{Value, json};

/// A home directory holding one Claude Code session, indexed where the app
/// keeps its index on macOS: Application Support, in a folder named for its
/// bundle identifier.
fn indexed_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("temp dir");
    let projects = home.path().join(".claude/projects/-w-proj");
    std::fs::create_dir_all(&projects).expect("creates");
    std::fs::write(
        projects.join("abc.jsonl"),
        concat!(
            r#"{"type":"user","message":{"role":"user","content":"Fix the parser"},"timestamp":"2026-09-11T23:38:22.696Z","cwd":"/w/proj","sessionId":"abc"}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":500}},"requestId":"req_1","timestamp":"2026-09-11T23:38:30.000Z","sessionId":"abc"}"#,
            "\n",
        ),
    )
    .expect("writes");
    let data = home
        .path()
        .join("Library/Application Support/com.joeychilson.overwatch");
    Index::open(&data, home.path().to_path_buf())
        .expect("opens")
        .scan(|_| {})
        .expect("scans");
    home
}

/// Run this executable in `home` with `arguments`.
fn overwatch(home: &tempfile::TempDir, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_overwatch"))
        .args(arguments)
        .env("HOME", home.path())
        .output()
        .expect("runs")
}

#[test]
fn an_agent_lists_the_sessions_the_app_indexed() {
    let home = indexed_home();
    let mut server = Command::new(env!("CARGO_BIN_EXE_overwatch"))
        .arg("mcp")
        .env("HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("starts");
    // Closing its input once everything is sent is what ends the server.
    {
        let mut input = server.stdin.take().expect("has input");
        for message in [
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" },
                },
            }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": { "name": "list_sessions", "arguments": {} },
            }),
        ] {
            writeln!(input, "{message}").expect("sends");
        }
    }
    let finished = server.wait_with_output().expect("finishes");
    assert!(
        finished.status.success(),
        "{}",
        String::from_utf8_lossy(&finished.stderr)
    );

    // Standard output carries nothing but the protocol: one answer a line.
    let answers: Vec<Value> = finished
        .stdout
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).expect("a line of JSON"))
        .collect();
    assert_eq!(answers.len(), 2);
    assert_eq!(answers[0]["id"], 1);
    assert_eq!(answers[0]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(answers[1]["id"], 2);
    assert_eq!(answers[1]["result"]["isError"], false);
    let text = answers[1]["result"]["content"][0]["text"]
        .as_str()
        .expect("text");
    let listed: Value = serde_json::from_str(text).expect("JSON");
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["sessions"][0]["id"], "claude_code:abc");
    assert_eq!(listed["sessions"][0]["tokens"], 500);
}

#[test]
fn a_tool_runs_once_from_a_shell_and_says_how_it_went_by_its_exit() {
    let home = indexed_home();

    let listed = overwatch(&home, &["call", "list_sessions", r#"{"limit": 1}"#]);
    assert!(listed.status.success(), "{listed:?}");
    let answer: Value = serde_json::from_slice(&listed.stdout).expect("JSON");
    assert_eq!(answer["sessions"][0]["id"], "claude_code:abc");

    // With no arguments, a tool takes its defaults.
    let limits = overwatch(&home, &["call", "get_limits"]);
    assert!(limits.status.success(), "{limits:?}");

    // A tool that cannot answer exits 1, saying why on standard error only.
    let refused = overwatch(&home, &["call", "list_sessions", r#"{"limit": 0}"#]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(refused.stdout.is_empty());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("limit is from 1 to 100"));

    // One not asked for properly exits 2, with how to ask.
    for asked in [
        vec!["call"],
        vec!["call", "nope"],
        vec!["call", "get_limits", "not json"],
        vec!["call", "get_limits", "[]"],
    ] {
        let wrong = overwatch(&home, &asked);
        assert_eq!(wrong.status.code(), Some(2), "{asked:?}");
        assert!(
            String::from_utf8_lossy(&wrong.stderr).contains("usage: overwatch call"),
            "{asked:?}"
        );
    }
}
