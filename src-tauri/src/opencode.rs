use crate::{
    data::*,
    error::Result,
    parse::{Accumulator, content, count, string},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Database {
    connection: Connection,
    path: PathBuf,
    modern: bool,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        let modern = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_v2')",
            [],
            |row| row.get(0),
        )?;
        Ok(Self {
            connection,
            path: path.into(),
            modern,
        })
    }
    pub fn sessions(&self) -> Result<Vec<(String, i64)>> {
        let sql = if self.modern {
            "SELECT id,time_updated FROM session_v2"
        } else {
            "SELECT id,time_updated FROM session"
        };
        let mut statement = self.connection.prepare_cached(sql)?;
        Ok(statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?)
    }
    pub fn read(&self, id: &str, detailed: bool) -> Result<Accumulator> {
        // A session's metadata, messages, and tool parts must come from one database view.
        let connection = self.connection.unchecked_transaction()?;
        let modern = self.modern;
        let path = &self.path;
        let mut data = Accumulator::new(Agent::Opencode, path, detailed);
        data.identity(id);
        let table = if modern { "session_v2" } else { "session" };
        connection.prepare_cached(&format!(
            "SELECT title,directory,time_created,time_updated,parent_id FROM {table} WHERE id=?1"
        ))?.query_row([id], |row| {
            data.session.title = row.get::<_, Option<String>>(0)?.unwrap_or_default();
            data.session.cwd = row.get(1)?;
            data.session.started_at = row.get(2)?;
            data.session.updated_at = row.get(3)?;
            data.session.parent_id = row.get(4)?;
            Ok(())
        })?;
        if modern {
            let mut statement = connection.prepare_cached("SELECT id,type,time_created,data FROM session_message WHERE session_id=?1 ORDER BY seq")?;
            for row in statement.query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })? {
                let (id, kind, timestamp, raw) = row?;
                let message: Value = serde_json::from_str(&raw)?;
                data.touch(timestamp);
                match kind.as_str() {
                    "user" => data.event(
                        &id,
                        EventKind::User,
                        timestamp,
                        content(&message["text"]),
                        None,
                    ),
                    "assistant" => {
                        data.session.model = string(&message["model"]["id"]).into();
                        usage(
                            &mut data,
                            &id,
                            timestamp,
                            &message,
                            string(&message["model"]["providerID"]),
                        );
                        if let Some(parts) = message["content"].as_array() {
                            for (index, value) in parts.iter().enumerate() {
                                part(
                                    &mut data,
                                    &format!("{id}:{index}"),
                                    timestamp,
                                    value,
                                    EventKind::Assistant,
                                );
                            }
                        }
                    }
                    "shell" => {
                        data.event(
                            &id,
                            EventKind::Tool,
                            timestamp,
                            content(&message["command"]),
                            Some("shell"),
                        );
                        data.result(
                            &id,
                            message["time"]["completed"].as_i64().unwrap_or(timestamp),
                            content(&message["output"]),
                            message["exit"].as_i64().map(|n| n != 0),
                        );
                    }
                    "synthetic" => data.event(
                        &id,
                        EventKind::Compaction,
                        timestamp,
                        content(&message["description"]),
                        None,
                    ),
                    _ => {}
                }
            }
        } else {
            let mut statement = connection.prepare_cached(
            "SELECT id,time_created,data FROM message WHERE session_id=?1 ORDER BY time_created,id",
        )?;
            let mut parts = connection.prepare_cached(
                "SELECT id,data FROM part WHERE message_id=?1 ORDER BY time_created,id",
            )?;
            for row in statement.query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })? {
                let (id, timestamp, raw) = row?;
                let message: Value = serde_json::from_str(&raw)?;
                let role = if message["role"] == "user" {
                    EventKind::User
                } else {
                    EventKind::Assistant
                };
                if let Some(model) = message["modelID"].as_str() {
                    data.session.model = model.into();
                }
                if role == EventKind::Assistant {
                    usage(
                        &mut data,
                        &id,
                        timestamp,
                        &message,
                        string(&message["providerID"]),
                    );
                }
                for row in parts.query_map([&id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })? {
                    let (id, raw) = row?;
                    part(
                        &mut data,
                        &id,
                        timestamp,
                        &serde_json::from_str::<Value>(&raw)?,
                        role,
                    );
                }
            }
        }
        data.session.source_path = format!("{}#{id}", path.display());
        Ok(data)
    }
}

fn usage(data: &mut Accumulator, id: &str, timestamp: i64, value: &Value, provider: &str) {
    let tokens = &value["tokens"];
    let reasoning = count(&tokens["reasoning"]);
    data.usage(
        id.into(),
        Usage {
            timestamp,
            model: data.session.model.clone(),
            provider: provider.into(),
            tokens: Tokens {
                input: count(&tokens["input"]),
                output: count(&tokens["output"]) + reasoning,
                reasoning,
                cache_read: count(&tokens["cache"]["read"]),
                cache_write: count(&tokens["cache"]["write"]),
            },
            reported_cost: value["cost"].as_f64().filter(|n| *n >= 0.0),
        },
    );
}
fn part(data: &mut Accumulator, id: &str, timestamp: i64, value: &Value, role: EventKind) {
    match string(&value["type"]) {
        "text" => data.event(id, role, timestamp, content(&value["text"]), None),
        "reasoning" => data.event(
            id,
            EventKind::Thinking,
            timestamp,
            content(&value["text"]),
            None,
        ),
        "compaction" => data.event(
            id,
            EventKind::Compaction,
            timestamp,
            "Context compacted".into(),
            None,
        ),
        "tool" => {
            let state = &value["state"];
            let key = value["id"]
                .as_str()
                .or(value["callID"].as_str())
                .unwrap_or(id);
            let name = value["name"].as_str().unwrap_or(string(&value["tool"]));
            let start = value["time"]["ran"]
                .as_i64()
                .or(state["time"]["start"].as_i64())
                .unwrap_or(timestamp);
            data.event(
                key,
                EventKind::Tool,
                start,
                content(&state["input"]),
                Some(name),
            );
            if state["status"] == "completed" || state["status"] == "error" {
                let end = value["time"]["completed"]
                    .as_i64()
                    .or(state["time"]["end"].as_i64())
                    .unwrap_or(start);
                let output = state
                    .get("content")
                    .or(state.get("output"))
                    .unwrap_or(&state["error"]);
                data.result(key, end, content(output), Some(state["status"] == "error"));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn both_database_generations_preserve_reasoning_cost_and_tool_results() -> Result<()> {
        for modern in [false, true] {
            let file = tempfile::NamedTempFile::new()?;
            let db = Connection::open(file.path())?;
            let table = if modern { "session_v2" } else { "session" };
            db.execute_batch(&format!("CREATE TABLE {table}(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
                INSERT INTO {table} VALUES('session','Database test','/work/project',1700000000000,1700000001000,NULL);"))?;
            let tool = json!({"type":"tool","callID":"tool-1","tool":"read","state":{"status":"error","input":{"path":"missing"},"error":"Missing file","time":{"start":1700000000100i64,"end":1700000000500i64}}});
            let usage = json!({"role":"assistant","modelID":"test","providerID":"lab","model":{"id":"test","providerID":"lab"},"tokens":{"input":40,"output":10,"reasoning":5,"cache":{"read":20,"write":3}},"cost":0,"content":[tool.clone()]});
            if modern {
                db.execute_batch("CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,time_created INTEGER,data TEXT,seq INTEGER)")?;
                db.execute("INSERT INTO session_message VALUES('message','session','assistant',1700000000000,?1,1)", [usage.to_string()])?;
            } else {
                db.execute_batch("CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,time_created INTEGER,data TEXT)")?;
                db.execute(
                    "INSERT INTO message VALUES('message','session',1700000000000,?1)",
                    [usage.to_string()],
                )?;
                db.execute(
                    "INSERT INTO part VALUES('part','message',1700000000000,?1)",
                    params![tool.to_string()],
                )?;
            }
            let database = Database::open(file.path())?;
            assert_eq!(database.sessions()?.len(), 1);
            let result = database.read("session", true)?;
            let summary = result.summary();
            assert_eq!(summary.tokens.total(), 78);
            assert_eq!(summary.tokens.output, 15);
            assert_eq!(summary.usage[0].reported_cost, Some(0.0));
            assert_eq!(summary.tools[0].failures, 1);
            assert_eq!(summary.tools[0].duration_ms, 400);
            assert_eq!(result.events[0].output.as_deref(), Some("Missing file"));
            db.execute_batch(&format!("UPDATE {table} SET title='Updated';
                INSERT INTO {table} VALUES('second','Empty session','/other/project',1700000000000,1700000001000,NULL)"))?;
            assert_eq!(database.sessions()?.len(), 2);
            assert!(database.read("missing", true).is_err());
            let empty = database.read("second", true)?.summary();
            assert_eq!(empty.tokens.total(), 0);
            assert!(empty.tools.is_empty());
            // Reusing the connection must release the previous read transaction.
            let updated = database.read("session", false)?.summary();
            assert_eq!(updated.title, "Updated");
            assert_eq!(updated.tokens.total(), summary.tokens.total());
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))?,
                2
            );
        }
        Ok(())
    }
}
