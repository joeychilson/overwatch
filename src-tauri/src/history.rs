use crate::{
    data::Session,
    error::{AppError, Result},
    settings,
};
use rusqlite::{Connection, Transaction, params};

/// Derived query data. Original summary rows remain available for repairing this
/// index and for native diagnostics; transcripts are never copied here.
pub fn initialize(db: &mut Connection) -> Result<Vec<String>> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS history_rows(
        source TEXT PRIMARY KEY, agent TEXT NOT NULL, id TEXT NOT NULL,
        updated INTEGER NOT NULL, started INTEGER NOT NULL, cwd TEXT NOT NULL,
        project TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL,
        search TEXT NOT NULL, tokens INTEGER NOT NULL, turns INTEGER NOT NULL,
        elapsed INTEGER, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS history_identity ON history_rows(id,updated DESC,source);
        CREATE INDEX IF NOT EXISTS history_scope ON history_rows(agent,cwd,updated DESC,id);
        CREATE INDEX IF NOT EXISTS history_recent ON history_rows(updated DESC,id);
        CREATE TABLE IF NOT EXISTS history_usage(
        source TEXT NOT NULL, ordinal INTEGER NOT NULL, timestamp INTEGER NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, input INTEGER NOT NULL,
        output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
        reasoning INTEGER NOT NULL, reported_cost REAL, PRIMARY KEY(source,ordinal));
        CREATE INDEX IF NOT EXISTS history_usage_date ON history_usage(timestamp,source);
        CREATE INDEX IF NOT EXISTS history_usage_model ON history_usage(provider,model,timestamp,source);
        CREATE TABLE IF NOT EXISTS history_tools(source TEXT NOT NULL,name TEXT NOT NULL,
        calls INTEGER NOT NULL,failures INTEGER NOT NULL,completed INTEGER NOT NULL,
        timed INTEGER NOT NULL,duration INTEGER NOT NULL,PRIMARY KEY(source,name));
        CREATE INDEX IF NOT EXISTS history_tool_name ON history_tools(name,source);
        CREATE TABLE IF NOT EXISTS history_limits(source TEXT NOT NULL,ordinal INTEGER NOT NULL,
        data TEXT NOT NULL,PRIMARY KEY(source,ordinal));
        CREATE TRIGGER IF NOT EXISTS history_delete AFTER DELETE ON sessions BEGIN
            DELETE FROM history_rows WHERE source=OLD.source;
            DELETE FROM history_usage WHERE source=OLD.source;
            DELETE FROM history_tools WHERE source=OLD.source;
            DELETE FROM history_limits WHERE source=OLD.source;
        END;")?;
    let current = settings::read::<u32>(db, "history/schema")? == Some(1);
    let tx = db.transaction()?;
    let mut invalid = Vec::new();
    {
        // Missing derived rows can be repaired from cached summaries even when
        // the original source is offline. Only undecodable summaries need a scan.
        let mut query = tx.prepare(if current {
            "SELECT source,data FROM sessions WHERE source NOT IN (SELECT source FROM history_rows)"
        } else {
            "SELECT source,data FROM sessions"
        })?;
        for row in query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (source, raw) = row?;
            match serde_json::from_str(&raw) {
                Ok(session) => upsert(&tx, &source, &session)?,
                Err(_) => invalid.push(source),
            }
        }
    }
    if !current {
        settings::write(&tx, "history/schema", &1)?;
    }
    tx.commit()?;
    Ok(invalid)
}

pub fn upsert(tx: &Transaction<'_>, source: &str, session: &Session) -> Result<()> {
    let mut light = session.clone();
    light.usage.clear();
    light.limits.clear();
    let elapsed = (session.started_at > 0 && session.updated_at >= session.started_at)
        .then_some(session.updated_at - session.started_at);
    tx.prepare_cached("INSERT OR REPLACE INTO history_rows VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)")?
        .execute(params![source,session.agent.id(),session.id,session.updated_at,session.started_at,
            session.cwd,session.project,session.model,session.title,
            format!("{} {} {}",session.title,session.cwd,session.model).to_lowercase(),
            integer(session.tokens.total())?,session.turns,elapsed,serde_json::to_string(&light)?])?;
    tx.execute("DELETE FROM history_usage WHERE source=?1", [source])?;
    tx.execute("DELETE FROM history_tools WHERE source=?1", [source])?;
    tx.execute("DELETE FROM history_limits WHERE source=?1", [source])?;
    let mut usage =
        tx.prepare_cached("INSERT INTO history_usage VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")?;
    for (ordinal, point) in session.usage.iter().enumerate() {
        usage.execute(params![
            source,
            ordinal as i64,
            point.timestamp,
            point.model,
            point.provider,
            integer(point.tokens.input)?,
            integer(point.tokens.output)?,
            integer(point.tokens.cache_read)?,
            integer(point.tokens.cache_write)?,
            integer(point.tokens.reasoning)?,
            point.reported_cost
        ])?;
    }
    let mut tools = tx.prepare_cached("INSERT INTO history_tools VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
    for tool in &session.tools {
        tools.execute(params![
            source,
            tool.name,
            tool.calls,
            tool.failures,
            tool.completed,
            tool.timed,
            integer(tool.duration_ms)?
        ])?;
    }
    let mut limits = tx.prepare_cached("INSERT INTO history_limits VALUES(?1,?2,?3)")?;
    for (ordinal, sample) in session
        .limits
        .iter()
        .filter(|sample| !sample.is_codex_spark())
        .enumerate()
    {
        limits.execute(params![
            source,
            ordinal as i64,
            serde_json::to_string(sample)?
        ])?;
    }
    Ok(())
}

fn integer(value: u64) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| AppError::InvalidData("Usage exceeds the supported integer range.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{Agent, Tokens, Usage};
    fn session() -> Session {
        Session {
            id: "test".into(),
            agent: Agent::Pi,
            title: "Title".into(),
            cwd: "/test".into(),
            project: "test".into(),
            model: "exact".into(),
            started_at: 1,
            updated_at: 2,
            messages: 1,
            turns: 1,
            compactions: 0,
            tokens: Tokens {
                input: 5,
                ..Tokens::default()
            },
            usage: vec![Usage {
                timestamp: 1,
                model: "exact".into(),
                provider: "lab".into(),
                tokens: Tokens {
                    input: 5,
                    ..Tokens::default()
                },
                reported_cost: Some(0.0),
            }],
            tools: vec![],
            limits: vec![],
            source_path: "source".into(),
            parent_id: None,
            warnings: vec![],
        }
    }
    #[test]
    fn migration_preserves_cached_usage_without_original_files() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT); CREATE TABLE sessions(source TEXT PRIMARY KEY,data TEXT);")?;
        db.execute(
            "INSERT INTO sessions VALUES('source',?1)",
            [serde_json::to_string(&session())?],
        )?;
        db.execute("INSERT INTO sessions VALUES('broken','invalid')", [])?;
        assert_eq!(initialize(&mut db)?, ["broken"]);
        db.execute("DELETE FROM history_rows WHERE source='source'", [])?;
        assert_eq!(initialize(&mut db)?, ["broken"]);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_rows", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        let light: Session =
            serde_json::from_str(&db.query_row("SELECT data FROM history_rows", [], |row| {
                row.get::<_, String>(0)
            })?)?;
        assert!(light.usage.is_empty() && light.limits.is_empty());
        assert_eq!(light.tokens.input, 5);
        assert_eq!(
            db.query_row("SELECT reported_cost FROM history_usage", [], |row| row
                .get::<_, f64>(0))?,
            0.0
        );
        assert_eq!(initialize(&mut db)?, ["broken"]);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_usage", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        Ok(())
    }
    #[test]
    fn rewrites_and_deletes_update_derived_data_atomically() -> Result<()> {
        let mut db = Connection::open_in_memory()?;
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT); CREATE TABLE sessions(source TEXT PRIMARY KEY,data TEXT); INSERT INTO sessions VALUES('source','invalid');")?;
        initialize(&mut db)?;
        let tx = db.transaction()?;
        upsert(&tx, "source", &session())?;
        tx.commit()?;
        let mut changed = session();
        changed.usage.clear();
        changed.title = "Updated".into();
        let tx = db.transaction()?;
        upsert(&tx, "source", &changed)?;
        tx.rollback()?;
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_usage", [], |row| row
                .get::<_, u32>(0))?,
            1
        );
        let tx = db.transaction()?;
        upsert(&tx, "source", &changed)?;
        tx.commit()?;
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_usage", [], |row| row
                .get::<_, u32>(0))?,
            0
        );
        db.execute("DELETE FROM sessions", [])?;
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM history_rows", [], |row| row
                .get::<_, u32>(0))?,
            0
        );
        Ok(())
    }
}
