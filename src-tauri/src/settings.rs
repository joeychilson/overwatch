use crate::{data::Source, error::Result, index::validate_sources};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;

pub fn read<T: DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM settings WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

pub fn write(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO settings(key,data) VALUES(?1,?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

pub fn initialize(
    db: &mut Connection,
    directory: &Path,
    defaults: Vec<Source>,
) -> Result<Vec<Source>> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL)",
    )?;
    if let Some(sources) = read::<Vec<Source>>(db, "sources")? {
        validate_sources(&sources)?;
        return Ok(sources);
    }
    // Import once, without changing the original settings file.
    let legacy: serde_json::Value = match std::fs::read(directory.join("settings.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Value::Null,
        Err(error) => return Err(error.into()),
    };
    let sources = legacy
        .get("sources")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or(defaults);
    validate_sources(&sources)?;
    let tx = db.transaction()?;
    write(&tx, "sources", &sources)?;
    if let Some(preferences) = legacy.get("preferences") {
        write(&tx, "preferences", preferences)?;
    }
    tx.commit()?;
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{data::Agent, index::Index};
    use serde_json::json;

    fn sources(path: &Path) -> Vec<Source> {
        Agent::ALL
            .into_iter()
            .map(|agent| Source {
                agent,
                path: path.to_string_lossy().into_owned(),
                enabled: true,
            })
            .collect()
    }

    #[test]
    fn imports_existing_settings_once_and_preserves_them_across_restarts() -> Result<()> {
        let root = tempfile::tempdir()?;
        let defaults = sources(&root.path().join("defaults"));
        let original = sources(&root.path().join("original"));
        let preferences =
            json!({"theme":"light","savedModels":["openai/example"],"sidebarCollapsed":true});
        let legacy = json!({"sources":original,"preferences":preferences}).to_string();
        let file = root.path().join("settings.json");
        std::fs::write(&file, &legacy)?;
        let index = Index::open(root.path().into(), defaults.clone())?;
        assert_eq!(index.sources()?, original);
        assert_eq!(
            read::<serde_json::Value>(&index.db.lock().unwrap(), "preferences")?,
            Some(preferences)
        );
        index.set_sources(defaults.clone())?;
        write(
            &index.db.lock().unwrap(),
            "preferences",
            &json!({"theme":"dark"}),
        )?;
        drop(index);
        let index = Index::open(root.path().into(), original)?;
        assert_eq!(index.sources()?, defaults);
        assert_eq!(
            read::<serde_json::Value>(&index.db.lock().unwrap(), "preferences")?,
            Some(json!({"theme":"dark"}))
        );
        assert_eq!(std::fs::read_to_string(file)?, legacy);
        Ok(())
    }

    #[test]
    fn failed_source_change_rolls_back_settings_sessions_and_allowance_history() -> Result<()> {
        let root = tempfile::tempdir()?;
        let original = sources(&root.path().join("original"));
        let index = Index::open(root.path().into(), original.clone())?;
        index.db.lock().unwrap().execute_batch("INSERT INTO accounts VALUES('codex','original','account');
            INSERT INTO samples VALUES('codex','identity','bucket',0,1,'sample');
            INSERT INTO sessions VALUES('source','codex','id','stamp',0,'session');
            CREATE TRIGGER fail_source_change BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")?;
        let mut updated = original.clone();
        updated[0].path = root.path().join("new").to_string_lossy().into_owned();
        assert!(index.set_sources(updated.clone()).is_err());
        assert_eq!(index.sources()?, original);
        {
            let db = index.db.lock().unwrap();
            assert_eq!(read::<Vec<Source>>(&db, "sources")?, Some(original));
            for (table, data) in [
                ("accounts", "account"),
                ("samples", "sample"),
                ("sessions", "session"),
            ] {
                assert_eq!(
                    db.query_row(&format!("SELECT data FROM {table}"), [], |row| row
                        .get::<_, String>(0))?,
                    data
                );
            }
            db.execute_batch("DROP TRIGGER fail_source_change")?;
        }
        index.set_sources(updated.clone())?;
        assert_eq!(index.sources()?, updated);
        drop(index);
        let index = Index::open(root.path().into(), sources(root.path()))?;
        assert_eq!(index.sources()?, updated);
        let db = index.db.lock().unwrap();
        for table in ["accounts", "samples", "sessions"] {
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, u32>(0))?,
                0
            );
        }
        Ok(())
    }
}
