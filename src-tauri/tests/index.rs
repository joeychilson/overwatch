use overwatch_lib::{
    data::{Agent, Source},
    index::Index,
};
use serde_json::json;
use std::io::Write;

#[test]
fn opencode_indexes_multiple_batches_and_reconciles_live_updates()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let db = rusqlite::Connection::open(root.path().join("opencode.db"))?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE session_v2(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
        CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,time_created INTEGER,data TEXT,seq INTEGER);
        WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<65)
        INSERT INTO session_v2 SELECT 's'||n,'Session '||n,'/fixture',1700000000000,1700000001000,NULL FROM ids;
        INSERT INTO session_message SELECT id,id,'assistant',time_updated,'{\"model\":{\"id\":\"example\",\"providerID\":\"lab\"},\"tokens\":{\"input\":10,\"output\":2}}',1 FROM session_v2;")?;
    let sources = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: root.path().to_string_lossy().into_owned(),
            enabled: agent == Agent::Opencode,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources)?;
    assert!(index.scan()?);
    let snapshot = index.snapshot()?;
    assert_eq!(snapshot.sessions.len(), 65);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .map(|s| s.tokens.total())
            .sum::<u64>(),
        65 * 12
    );
    assert!(!index.scan()?);
    // Parser changes must rebuild an unchanged database's cached summaries.
    index.db.lock().unwrap().execute_batch(
        "UPDATE sessions SET stamp='1700000001000',data=json_set(data,'$.title','Stale summary') WHERE id='opencode:s65'",
    )?;
    assert!(index.scan()?);
    assert!(
        index
            .snapshot()?
            .sessions
            .iter()
            .all(|s| s.title != "Stale summary")
    );
    assert!(!index.scan()?);
    db.execute_batch(
        "UPDATE session_v2 SET title='Changed',time_updated=time_updated+1000 WHERE id='s65';
        DELETE FROM session_v2 WHERE id='s1';",
    )?;
    assert!(index.scan_paths(&[root.path().join("opencode.db-wal")].into())?);
    let snapshot = index.snapshot()?;
    assert_eq!(snapshot.sessions.len(), 64);
    assert_eq!(snapshot.sessions[0].title, "Changed");
    assert_eq!(index.transcript("opencode:s65")?.session.tokens.total(), 12);
    assert!(!index.scan()?);
    Ok(())
}

#[test]
fn outdated_jsonl_summaries_rebuild_only_when_the_source_is_available()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    std::fs::create_dir_all(directory.join("sessions"))?;
    let path = directory.join("sessions/test.jsonl");
    let original = format!(
        "{}\n",
        json!({"type":"message","id":"user",
        "message":{"role":"user","content":"Original title"}})
    );
    std::fs::write(&path, &original)?;
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
    let metadata = path.metadata()?;
    let old_stamp = format!(
        "{}:{}",
        metadata.len(),
        metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    );
    index.db.lock().unwrap().execute(
        "UPDATE sessions SET stamp=?1,data=json_set(data,'$.title','Cached title')",
        [old_stamp],
    )?;
    let offline = root.path().join("offline");
    std::fs::rename(&directory, &offline)?;
    index.scan()?;
    assert_eq!(index.snapshot()?.sessions[0].title, "Cached title");
    // A restart also retains the old summary until rebuilding can succeed.
    let sources = index.sources()?;
    drop(index);
    let index = Index::open(root.path().join("index"), sources)?;
    assert_eq!(index.snapshot()?.sessions[0].title, "Cached title");
    std::fs::rename(&offline, &directory)?;
    assert!(index.scan()?);
    assert_eq!(index.snapshot()?.sessions[0].title, "Original title");
    assert_eq!(std::fs::read_to_string(path)?, original);
    assert!(!index.scan()?);
    Ok(())
}

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
    assert!(index.scan_paths(&[summary].into())?);
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
    let id = &snapshot.sessions[0].id;
    let page = index.events(id, 100, "")?;
    assert_eq!(page.events.len(), 100);
    assert!(page.matches.is_empty());
    let page = index.events(id, 100, "Record")?;
    assert_eq!(page.matches, (100..200).collect::<Vec<_>>());
    let result = index.events(id, 0, "Record 244")?;
    assert_eq!(result.matches, vec![244]);
    assert_eq!(index.transcript(id)?.timeline.len(), 245);
    assert_eq!(
        index.events(id, u32::MAX, "RECORD")?.matches,
        (200..245).collect::<Vec<_>>()
    );
    assert_eq!(index.events(id, u32::MAX, "record")?.offset, 200);
    assert_eq!(index.events(id, 0, "absent")?.total, 0);
    assert_eq!(index.events(id, 0, "")?.total, 245);
    // The active reader sees appends without waiting for the background index scan.
    writeln!(
        file,
        "{}",
        json!({"id":"tool","type":"message","timestamp":1700000300000i64,"message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"shell","arguments":"pwd"}]}})
    )?;
    assert_eq!(index.events(id, 0, "absent")?.total, 0);
    assert_eq!(index.events(id, 0, "SHELL")?.matches, vec![245]);
    assert_eq!(index.events(id, 0, "résultat")?.total, 0);
    // A result changes an existing event without increasing the event count.
    writeln!(
        file,
        "{}",
        json!({"id":"result","type":"message","timestamp":1700000301000i64,"message":{"role":"toolResult","toolCallId":"call","content":"RÉSULTAT"}})
    )?;
    assert_eq!(index.events(id, 0, "résultat")?.matches, vec![245]);
    assert_eq!(index.events(id, 0, "")?.total, 246);
    std::fs::write(
        &path,
        format!(
            "{}\n",
            json!({"id":"replacement","type":"message","message":{"role":"user","content":"Replacement"}})
        ),
    )?;
    assert_eq!(index.events(id, 0, "résultat")?.total, 0);
    assert_eq!(index.events(id, 0, "replacement")?.matches, vec![0]);
    let missing = directory.join("hidden-sessions");
    std::fs::rename(directory.join("sessions"), &missing)?;
    assert!(index.scan()?);
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    assert!(!index.snapshot()?.sources[3].issues.is_empty());
    std::fs::rename(&missing, directory.join("sessions"))?;
    assert!(index.scan()?);
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

#[test]
fn incremental_scans_isolate_paths_and_reconcile_missed_events()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    std::fs::create_dir_all(directory.join("sessions"))?;
    let a = directory.join("sessions/a.jsonl");
    let b = directory.join("sessions/b.jsonl");
    let message = |text: &str| {
        format!(
            "{}\n",
            json!({"type":"message","message":{"role":"user","content":text}})
        )
    };
    std::fs::write(&a, message("First A"))?;
    std::fs::write(&b, message("First B"))?;
    let sources: Vec<_> = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Pi,
        })
        .collect();
    let index = std::sync::Arc::new(Index::open(root.path().join("index"), sources.clone())?);
    let progress_index = std::sync::Arc::downgrade(&index);
    index.set_progress_handler(std::sync::Arc::new(move || {
        // Progress callbacks can query committed rows without locking the writer.
        let index = progress_index.upgrade().unwrap();
        assert!(index.history_status().is_ok());
        assert!(index.scanning.load(std::sync::atomic::Ordering::Relaxed));
    }))?;
    index.scan()?;
    index.take_changes(false)?;
    let a_id = index
        .snapshot()?
        .sessions
        .iter()
        .find(|s| s.title == "First A")
        .unwrap()
        .id
        .clone();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&a)?
        .write_all(message("Second A").as_bytes())?;
    // Change B without notifying the index. Its cache must stay untouched.
    std::fs::write(&b, message("Replacement B"))?;
    assert!(index.scan_paths(&[a.clone()].into())?);
    let snapshot = index.snapshot()?;
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .find(|s| s.id == a_id)
            .unwrap()
            .messages,
        2
    );
    assert!(snapshot.sessions.iter().any(|s| s.title == "First B"));
    assert_eq!(
        index.take_changes(false)?.sessions,
        Some(vec![a_id.clone()])
    );
    assert!(!index.scan_paths(&[directory.join("irrelevant.json")].into())?);
    assert!(index.scan()?);
    assert!(
        index
            .snapshot()?
            .sessions
            .iter()
            .any(|s| s.title == "Replacement B")
    );
    // Truncation, rename and deletion affect only the named paths.
    std::fs::write(&a, message("Truncated A"))?;
    index.scan_paths(&[a.clone()].into())?;
    assert_eq!(index.transcript(&a_id)?.session.messages, 1);
    let moved = directory.join("sessions/moved.jsonl");
    std::fs::rename(&a, &moved)?;
    index.scan_paths(&[a, moved.clone()].into())?;
    assert_eq!(index.snapshot()?.sessions.len(), 2);
    std::fs::remove_file(&moved)?;
    index.scan_paths(&[moved].into())?;
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    // Unavailable roots preserve history; recreation discovers the replacement.
    let offline = root.path().join("offline");
    std::fs::rename(&directory, &offline)?;
    index.scan_paths(&[directory.clone()].into())?;
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    std::fs::rename(&offline, &directory)?;
    assert!(index.scan_paths(&[directory.clone()].into())?);
    let disabled = sources
        .into_iter()
        .map(|mut s| {
            s.enabled = false;
            s
        })
        .collect();
    index.set_sources(disabled)?;
    assert!(!index.scan_paths(&[b].into())?);
    assert!(index.snapshot()?.sessions.is_empty());
    Ok(())
}

#[test]
fn codex_archive_moves_keep_one_session_and_targeted_change()
-> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let directory = root.path().join("history");
    std::fs::create_dir_all(directory.join("sessions"))?;
    std::fs::create_dir_all(directory.join("archived_sessions"))?;
    let active = directory.join("sessions/test.jsonl");
    std::fs::write(
        &active,
        format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":"archive-test","cwd":"/project"}})
        ),
    )?;
    let sources = Agent::ALL
        .into_iter()
        .map(|agent| Source {
            agent,
            path: directory.to_string_lossy().into_owned(),
            enabled: agent == Agent::Codex,
        })
        .collect();
    let index = Index::open(root.path().join("index"), sources)?;
    index.scan()?;
    index.take_changes(false)?;
    let archived = directory.join("archived_sessions/test.jsonl");
    std::fs::rename(&active, &archived)?;
    assert!(index.scan_paths(&[active, archived.clone()].into())?);
    assert_eq!(index.snapshot()?.sessions.len(), 1);
    assert_eq!(index.source_path("codex:archive-test")?, archived);
    assert_eq!(
        index.take_changes(false)?.sessions,
        Some(vec!["codex:archive-test".into()])
    );
    Ok(())
}
