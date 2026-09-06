use overwatch_lib::{
    data::{Agent, Source},
    index::Index,
};
use serde_json::json;
use std::io::Write;

#[test]
fn opencode_source_path_opens_the_database_and_respects_disabled_sources()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history#with-hash");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("opencode.db");
    let db = rusqlite::Connection::open(&path)?;
    db.execute_batch("CREATE TABLE session_v2(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
        INSERT INTO session_v2 VALUES('test','Test','/fixture',1700000000000,1700000001000,NULL);
        CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,time_created INTEGER,data TEXT,seq INTEGER);")?;
    let mut sources: Vec<_> = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Opencode,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources.clone())?;
    index.scan()?;
    let id = index.snapshot()?.sessions[0].id.clone();
    // Source opening only needs the indexed path, even if the transcript is unreadable.
    db.execute_batch("DROP TABLE session_message;")?;
    assert_eq!(index.source_path(&id)?, path);
    assert!(index.transcript(&id).is_err());
    sources.iter_mut().for_each(|source| source.enabled = false);
    index.set_sources(sources)?;
    assert!(index.source_path(&id).is_err());
    Ok(())
}

#[test]
fn grok_summary_changes_refresh_an_open_transcript() -> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    let session = directory.join("sessions/test");
    std::fs::create_dir_all(&session)?;
    std::fs::write(
        session.join("updates.jsonl"),
        format!(
            "{}\n",
            json!({"params":{"sessionId":"test","update":{
                "sessionUpdate":"user_message_chunk","content":{"text":"Hello"}
            }}})
        ),
    )?;
    let summary = session.join("summary.json");
    std::fs::write(&summary, r#"{"generated_title":"Original"}"#)?;
    let sources = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Grok,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources)?;
    index.scan()?;
    let id = index.snapshot()?.sessions[0].id.clone();
    assert_eq!(index.transcript(&id)?.session.title, "Original");
    std::fs::write(&summary, r#"{"generated_title":"Updated title"}"#)?;
    assert!(index.scan()?);
    assert_eq!(index.snapshot()?.sessions[0].title, "Updated title");
    assert_eq!(index.transcript(&id)?.session.title, "Updated title");
    assert!(!index.scan()?);
    Ok(())
}

#[test]
fn index_survives_restart_skips_idle_writes_and_pages_full_search()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    std::fs::create_dir_all(directory.join("sessions"))?;
    let path = directory.join("sessions/test.jsonl");
    let mut file = std::fs::File::create(&path)?;
    for i in 0..245 {
        writeln!(
            file,
            "{}",
            json!({"id":format!("event-{i}"),"timestamp":1700000000000i64+i*1000,"type":"message","message":{"role":"user","content":format!("Record {i}")}})
        )?;
    }
    let sources: Vec<_> = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Pi,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources.clone())?;
    assert!(index.scan()?);
    let snapshot = index.snapshot()?;
    assert_eq!(snapshot.sessions.len(), 1);
    assert!(!index.scan()?);
    assert_eq!(index.snapshot()?.indexed_at, snapshot.indexed_at);
    let id = &snapshot.sessions[0].id;
    let page = index.events(id, 100, "")?;
    assert_eq!(page.events.len(), 100);
    assert!(page.matches.is_empty());
    let page = index.events(id, 100, "Record")?;
    assert_eq!(page.matches, (100..200).collect::<Vec<_>>());
    let result = index.events(id, 0, "Record 244")?;
    assert_eq!(result.matches, vec![244]);
    assert_eq!(index.transcript(id)?.timeline.len(), 245);
    drop(index);
    let index = Index::open(root.path().join("index"), sources)?;
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    std::fs::remove_file(path)?;
    assert!(index.scan()?);
    assert!(index.snapshot()?.sessions.is_empty());
    Ok(())
}

#[test]
fn unreadable_cached_summary_keeps_other_sessions_and_recovers_without_source_changes()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    std::fs::create_dir_all(directory.join("sessions"))?;
    for id in ["healthy", "damaged"] {
        let mut file = std::fs::File::create(directory.join(format!("sessions/{id}.jsonl")))?;
        writeln!(
            file,
            "{}",
            json!({"type":"session","id":id,"cwd":"/fixture"})
        )?;
        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"response","timestamp":1700000000000i64,"message":{"role":"assistant","model":"example","provider":"lab","content":"Recorded response","usage":{"input":100,"output":20}}})
        )?;
    }
    let sources = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Pi,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources)?;
    index.scan()?;
    let original = index.snapshot()?;
    assert_eq!(original.sessions.len(), 2);
    let damaged = original
        .sessions
        .iter()
        .find(|session| session.id.contains("damaged"))
        .unwrap();
    let source_bytes = std::fs::read(&damaged.source_path)?;
    index
        .db
        .lock()
        .unwrap()
        .execute("UPDATE sessions SET data='{}' WHERE id=?1", [&damaged.id])?;
    let partial = index.snapshot()?;
    assert_eq!(partial.sessions.len(), 1);
    assert!(
        partial
            .sources
            .iter()
            .find(|source| source.source.agent == Agent::Pi)
            .unwrap()
            .issues
            .iter()
            .any(|issue| issue.contains("cached session"))
    );
    let offline = root.path().join("offline-history");
    std::fs::rename(&directory, &offline)?;
    index.scan()?;
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    assert_eq!(
        index
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))?,
        2
    );
    std::fs::rename(&offline, &directory)?;
    assert!(index.scan()?);
    let repaired = index.snapshot()?;
    assert_eq!(repaired.sessions.len(), 2);
    assert!(
        repaired
            .sources
            .iter()
            .all(|source| source.issues.is_empty())
    );
    assert_eq!(std::fs::read(&damaged.source_path)?, source_bytes);
    assert!(!index.scan()?);
    Ok(())
}
