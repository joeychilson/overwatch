use crate::{
    data::{Agent, Source, SourcePreview, SourceStatus},
    error::{AppError, Result},
};
use rusqlite::Connection;
use std::path::Path;

pub(crate) fn preview(
    db: &Connection,
    statuses: &[SourceStatus],
    source: Source,
) -> Result<SourcePreview> {
    if !Path::new(&source.path).is_absolute() {
        return Err(AppError::InvalidData(
            "Source folders must be absolute paths.".into(),
        ));
    }
    let current = statuses
        .iter()
        .find(|status| status.source.agent == source.agent)
        .ok_or_else(|| AppError::InvalidData("Unknown history source.".into()))?
        .source
        .clone();
    let root = Path::new(&source.path);
    let mut issues = Vec::new();
    let available = root.is_dir();
    if !available {
        issues.push(
            "This folder is unavailable. History will be read when it becomes available.".into(),
        );
    } else {
        std::fs::read_dir(root)?;
        let recognized = match source.agent {
            Agent::Opencode => {
                let file = root.join("opencode.db");
                if file.is_file() {
                    crate::opencode::Database::open(&file)?.sessions()?;
                    true
                } else {
                    false
                }
            }
            Agent::Antigravity => true,
            agent => {
                let folders: &[&str] = match agent {
                    Agent::Codex => &["sessions", "archived_sessions"],
                    Agent::Claude => &["projects"],
                    _ => &["sessions"],
                };
                let mut found = false;
                for folder in folders {
                    let directory = root.join(folder);
                    if directory.is_dir() {
                        std::fs::read_dir(directory)?;
                        found = true;
                    }
                }
                found
            }
        };
        if !recognized {
            issues.push("No recognized history was found in this folder. Check that it is the agent’s root folder.".into());
        }
    }
    let changed = current.path != source.path;
    let count = |table: &str| -> Result<u32> {
        if !changed {
            return Ok(0);
        }
        Ok(db.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE agent=?1"),
            [source.agent.id()],
            |row| row.get(0),
        )?)
    };
    Ok(SourcePreview {
        sessions: count("sessions")?,
        allowance_samples: count("samples")?,
        account: count("accounts")? > 0,
        current,
        source,
        available,
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;

    fn index(root: &Path) -> Result<Index> {
        Index::open(
            root.join("index"),
            Agent::ALL
                .into_iter()
                .map(|agent| Source {
                    agent,
                    path: root.join(agent.id()).to_string_lossy().into_owned(),
                    enabled: true,
                })
                .collect(),
        )
    }

    #[test]
    fn preview_is_read_only_and_reports_unrecoverable_history() -> Result<()> {
        let root = tempfile::tempdir()?;
        let index = index(root.path())?;
        let original = index.sources()?;
        index.db.lock()?.execute_batch(
            "INSERT INTO accounts VALUES('codex','old','account');
            INSERT INTO samples VALUES('codex','identity','weekly',0,1,'sample');
            INSERT INTO sessions VALUES('source','codex','id','stamp',0,'session');",
        )?;
        let mut source = original[0].clone();
        source.path = root.path().join("missing").to_string_lossy().into_owned();
        let preview = index.preview_source(source)?;
        assert_eq!(preview.sessions, 1);
        assert_eq!(preview.allowance_samples, 1);
        assert!(preview.account && !preview.available && !preview.issues.is_empty());
        assert_eq!(index.sources()?, original);
        assert_eq!(
            index
                .db
                .lock()?
                .query_row("SELECT COUNT(*) FROM samples", [], |r| r.get::<_, u32>(0))?,
            1
        );
        Ok(())
    }

    #[test]
    fn stale_preview_cannot_clear_new_history() -> Result<()> {
        let root = tempfile::tempdir()?;
        let index = index(root.path())?;
        let original = index.sources()?;
        let mut source = original[0].clone();
        source.path = root.path().join("new").to_string_lossy().into_owned();
        let preview = index.preview_source(source)?;
        index.db.lock()?.execute_batch(
            "INSERT INTO samples VALUES('codex','identity','weekly',0,1,'sample');",
        )?;
        assert!(index.save_source_preview(preview).is_err());
        assert_eq!(index.sources()?, original);
        Ok(())
    }

    #[test]
    fn confirmed_change_preserves_other_sources_and_disable_preserves_history() -> Result<()> {
        let root = tempfile::tempdir()?;
        let index = index(root.path())?;
        let mut source = index.sources()?[0].clone();
        source.path = root.path().join("new").to_string_lossy().into_owned();
        std::fs::create_dir_all(Path::new(&source.path).join("sessions"))?;
        let preview = index.preview_source(source)?;
        assert!(preview.available && preview.issues.is_empty());
        let mut others = index.sources()?;
        others[1].enabled = false;
        index.set_sources(others.clone())?;
        index.save_source_preview(preview)?;
        assert_eq!(index.sources()?[1], others[1]);
        index.db.lock()?.execute_batch(
            "INSERT INTO samples VALUES('codex','identity','weekly',0,1,'sample');",
        )?;
        let mut source = index.sources()?[0].clone();
        source.enabled = false;
        let preview = index.preview_source(source)?;
        assert_eq!(preview.allowance_samples, 0);
        index.save_source_preview(preview)?;
        assert_eq!(
            index
                .db
                .lock()?
                .query_row("SELECT COUNT(*) FROM samples", [], |r| r.get::<_, u32>(0))?,
            1
        );
        Ok(())
    }
}
