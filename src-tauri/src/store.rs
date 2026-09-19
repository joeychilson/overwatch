//! The index: one SQLite file holding a row per session, what each session
//! used by quarter hour, and the file signatures that make rescanning
//! incremental. No transcript text is kept; bodies stay in the agents' files.
//!
//! The index is a cache, not a record. Everything in it can be rebuilt from
//! the agents' files, so a new schema, or new prices, drops the tables and
//! rebuilds rather than migrating, and no index in the wild can have a shape
//! a migration did not expect.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use rusqlite::types::{
    FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, Type, Value, ValueRef,
};
use rusqlite::{Connection, ErrorCode, OptionalExtension, Row, params, params_from_iter};

use crate::error::{Error, Result};
use crate::session::{
    Account, Agent, AgentDay, AgentTotals, DayTotals, Filter, HourTotals, ModelDay, ModelUsage,
    Overview, ProjectUsage, Provider, Session, SessionPage, SortKey, Tokens,
};
pub use crate::source::Unit;
use crate::source::{QUARTER_HOUR, Summary};

/// Bumped whenever the schema or what a reader records changes, which
/// rebuilds the index.
const SCHEMA: i64 = 10;

/// The largest page the list returns, however much is asked for.
const MAX_PAGE: i64 = 500;

/// The columns [`read_session`] reads, in its order, before the model shares.
const SESSION: &str = "id, agent, native_id, title, cwd, branch, started_at, updated_at, \
                       spawned, role, input, output, cache_read, cache_write, reasoning, \
                       total_tokens, cost_usd, messages, tools, present";

/// Usage rows summed in the order [`read_tokens`] reads them, then their cost.
const SUMS: &str = "SUM(input) AS input, SUM(output) AS output, \
                    SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, \
                    SUM(reasoning) AS reasoning, SUM(total) AS total, SUM(cost_usd) AS cost_usd";

/// The local day a usage row falls in, as the instant of the midnight that
/// starts it.
///
/// SQLite applies the local zone's rules to each instant, so a day beside a
/// clock change is 23 or 25 hours long rather than shifted by an hour.
const LOCAL_DAY: &str = "unixepoch(date(at / 1000, 'unixepoch', 'localtime'), 'utc') * 1000";

/// The local hour a usage row falls in, as the instant it starts.
///
/// The zone's offset at the instant says how far into its local hour it is,
/// so every span is an hour long. Grouping on the clock's reading would fold
/// the hour repeated when clocks go back into one span of two hours, and whole
/// hours of universal time would start half an hour off in zones such as
/// India's.
const LOCAL_HOUR: &str = "at - (at + (unixepoch(datetime(at / 1000, 'unixepoch', 'localtime')) \
                          - at / 1000) * 1000) % 3600000";

/// A session, and the unit its history was last read from.
pub(crate) struct Origin {
    /// The session, as the list shows it.
    pub(crate) session: Session,
    /// The unit it was last read from.
    pub(crate) unit: Unit,
}

/// The index database.
pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open the index at `path`, creating it, or rebuilding it when it was
    /// built by another schema or with other prices, or is not a readable
    /// database at all.
    pub(crate) fn open(path: &Path) -> Result<Store> {
        match Store::connect(path) {
            Err(Error::Store(error))
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
                ) =>
            {
                // A cache of the agents' files is rebuilt rather than stopping
                // the app from starting.
                for suffix in ["", "-wal", "-shm"] {
                    let mut file = path.as_os_str().to_owned();
                    file.push(suffix);
                    match std::fs::remove_file(&file) {
                        Err(source) if source.kind() != std::io::ErrorKind::NotFound => {
                            return Err(Error::Write {
                                path: Path::new(&file).display().to_string(),
                                source,
                            });
                        }
                        _ => {}
                    }
                }
                Store::connect(path)
            }
            opened => opened,
        }
    }

    /// Open the index at `path`, creating it, or rebuilding it when its schema
    /// or prices moved on.
    fn connect(path: &Path) -> Result<Store> {
        let connection = Connection::open(path)?;
        // WAL keeps reads from blocking the scanner's writes, and NORMAL is
        // durable enough for a cache that can be rebuilt.
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA mmap_size = 268435456;",
        )?;

        // Costs are estimated as the index is built, so new prices rebuild it
        // as a new schema does.
        let version = format!("{SCHEMA}.{:x}", crate::price::version());
        // No table, no row, or another version: each means a rebuild.
        let found: Option<String> = connection
            .query_row("SELECT value FROM meta WHERE key = 'schema'", [], |row| {
                row.get(0)
            })
            .ok();
        if found.as_deref() != Some(version.as_str()) {
            let tables: Vec<String> = connection
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for table in tables {
                connection.execute(&format!("DROP TABLE \"{table}\""), [])?;
            }
            connection.execute_batch(include_str!("schema.sql"))?;
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('schema', ?1)",
                [version],
            )?;
        }
        Ok(Store { connection })
    }

    /// The signature of every file the index has read, by path: its
    /// modification time and size when it was read.
    pub(crate) fn signatures(&self) -> Result<HashMap<String, (i64, i64)>> {
        let mut statement = self
            .connection
            .prepare("SELECT path, mtime, size FROM files")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Write what one unit holds, in a single transaction.
    ///
    /// A session can span several units, as a Codex thread resumed into a new
    /// file does, so a unit replaces only its own usage and the session's
    /// totals are summed from all of it. The session keeps the title of its
    /// earliest unit, and the path, directory, branch and role of its latest,
    /// or of another where that one recorded none; it is spawned if any unit
    /// says so. Units are read in parallel and written in any order, so none
    /// of this depends on which is written last.
    pub(crate) fn put(&mut self, unit: &Unit, summaries: &[Summary]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let path = unit.path.to_string_lossy();
        // A file keeps its name when moved, as Codex's are when archived, so
        // a moved file replaces its usage rather than adding to it.
        let source = unit
            .path
            .file_name()
            .map(OsStr::to_string_lossy)
            .unwrap_or_default();
        {
            // Unqualified columns in the update are the stored row's.
            let mut upsert = transaction.prepare_cached(
                "INSERT INTO sessions (id, agent, native_id, title, cwd, branch, started_at,
                                       updated_at, spawned, role, path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT (id) DO UPDATE SET
                    title = iif(excluded.started_at <= started_at,
                                COALESCE(excluded.title, title), COALESCE(title, excluded.title)),
                    path = iif(excluded.updated_at >= updated_at, excluded.path, path),
                    cwd = iif(excluded.updated_at >= updated_at,
                              COALESCE(excluded.cwd, cwd), COALESCE(cwd, excluded.cwd)),
                    branch = iif(excluded.updated_at >= updated_at,
                                 COALESCE(excluded.branch, branch),
                                 COALESCE(branch, excluded.branch)),
                    role = iif(excluded.updated_at >= updated_at,
                               COALESCE(excluded.role, role), COALESCE(role, excluded.role)),
                    started_at = MIN(started_at, excluded.started_at),
                    updated_at = MAX(updated_at, excluded.updated_at),
                    spawned = spawned OR excluded.spawned,
                    present = 1",
            )?;
            let mut clear = transaction
                .prepare_cached("DELETE FROM usage WHERE session_id = ?1 AND source = ?2")?;
            let mut record = transaction.prepare_cached(
                "INSERT INTO usage (session_id, source, at, provider, model, agent, input, output,
                                    cache_read, cache_write, reasoning, total, cost_usd)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            let mut total = transaction.prepare_cached(&format!(
                "UPDATE sessions SET
                    (input, output, cache_read, cache_write, reasoning, total_tokens, cost_usd) =
                    (SELECT COALESCE(SUM(input), 0), COALESCE(SUM(output), 0),
                            COALESCE(SUM(cache_read), 0), COALESCE(SUM(cache_write), 0),
                            COALESCE(SUM(reasoning), 0), COALESCE(SUM(total), 0), SUM(cost_usd)
                     FROM usage WHERE session_id = ?1),
                    models = {models}
                 WHERE id = ?1",
                models = shares("session_id = ?1"),
            ))?;

            for Summary { session, usage } in summaries {
                upsert.execute(params![
                    session.id,
                    session.agent,
                    session.native_id,
                    session.title,
                    session.cwd,
                    session.branch,
                    session.started_at,
                    session.updated_at,
                    session.spawned,
                    session.role,
                    path,
                ])?;
                clear.execute(params![session.id, source])?;
                for used in usage {
                    let tokens = &used.tokens;
                    record.execute(params![
                        session.id,
                        source,
                        used.at,
                        used.provider,
                        used.model,
                        session.agent,
                        tokens.input,
                        tokens.output,
                        tokens.cache_read,
                        tokens.cache_write,
                        tokens.reasoning,
                        tokens.total,
                        used.cost_usd,
                    ])?;
                }
                total.execute([&session.id])?;
            }
            transaction
                .prepare_cached("REPLACE INTO files (path, mtime, size) VALUES (?1, ?2, ?3)")?
                .execute(params![path, unit.mtime, unit.size])?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Keep a subscription's accounts, replacing what was kept for it before.
    ///
    /// Only accounts whose limits have been read are kept: one never read has
    /// nothing to show on the next launch.
    pub(crate) fn put_accounts(&mut self, provider: Provider, accounts: &[Account]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM accounts WHERE provider = ?1", [provider.key()])?;
        {
            let mut insert = transaction.prepare_cached(
                "INSERT INTO accounts (id, provider, account) VALUES (?1, ?2, ?3)",
            )?;
            for account in accounts.iter().filter(|account| account.read_at.is_some()) {
                // Serializing fails only on a map with non-string keys, and an
                // account holds no map.
                let json = serde_json::to_string(account).expect("an account serializes");
                insert.execute(params![account.id, provider.key(), json])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Forget files that are no longer on disk, marking their sessions absent.
    ///
    /// The sessions themselves are kept: history an agent has since deleted is
    /// still history.
    pub(crate) fn retire(&mut self, missing: &[String]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        {
            let mut forget = transaction.prepare_cached("DELETE FROM files WHERE path = ?1")?;
            let mut absent =
                transaction.prepare_cached("UPDATE sessions SET present = 0 WHERE path = ?1")?;
            for path in missing {
                forget.execute([path])?;
                absent.execute([path])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Store the counts learned by reading a conversation in full.
    pub(crate) fn put_counts(&mut self, id: &str, messages: i64, tools: i64) -> Result<()> {
        self.connection.execute(
            "UPDATE sessions SET messages = ?2, tools = ?3 WHERE id = ?1",
            params![id, messages, tools],
        )?;
        Ok(())
    }

    /// One page of the session list, with the totals of the whole match.
    ///
    /// Narrowed to a period, the list holds the sessions that used tokens in
    /// it, and each session's tokens, cost and models are what it used there,
    /// as the overview counts the same period; the list is ordered and
    /// totalled by those. Otherwise they are the session's whole usage.
    pub fn list(&self, filter: &Filter) -> Result<SessionPage> {
        let Listing {
            rows,
            models,
            bindings,
        } = self.listing(filter)?;
        let direction = if filter.sort.descending {
            "DESC"
        } else {
            "ASC"
        };
        let order = format!("{} {direction}, id", sort_column(filter.sort.key));
        let limit = filter.limit.clamp(1, MAX_PAGE);
        let offset = filter.offset.max(0);

        // The page is chosen before its model shares are summed, so a period
        // sums them only for the rows returned.
        let sessions = self
            .connection
            .prepare(&format!(
                "SELECT {SESSION}, {models}
                 FROM (SELECT * FROM {rows} ORDER BY {order} LIMIT {limit} OFFSET {offset}) AS page
                 ORDER BY {order}"
            ))?
            .query_map(params_from_iter(&bindings), read_session)?
            .collect::<rusqlite::Result<_>>()?;
        let (total, tokens, cost_usd) = self.connection.query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(input), 0), COALESCE(SUM(output), 0),
                        COALESCE(SUM(cache_read), 0), COALESCE(SUM(cache_write), 0),
                        COALESCE(SUM(reasoning), 0), COALESCE(SUM(total_tokens), 0),
                        SUM(cost_usd)
                 FROM {rows}"
            ),
            params_from_iter(&bindings),
            |row| Ok((row.get(0)?, read_tokens(row, 1)?, row.get(7)?)),
        )?;
        Ok(SessionPage {
            sessions,
            total,
            tokens,
            cost_usd,
        })
    }

    /// One session by id.
    pub(crate) fn get(&self, id: &str) -> Result<Option<Session>> {
        Ok(self
            .connection
            .query_row(
                &format!("SELECT {SESSION}, models FROM sessions WHERE id = ?1"),
                [id],
                read_session,
            )
            .optional()?)
    }

    /// Where a session's history lives, and its agent's own id for it.
    pub fn locate(&self, id: &str) -> Result<Option<(Unit, String)>> {
        Ok(self
            .connection
            .query_row(
                "SELECT agent, sessions.path, mtime, size, native_id
                 FROM sessions LEFT JOIN files ON files.path = sessions.path
                 WHERE id = ?1",
                [id],
                |row| Ok((read_unit(row, 0)?, row.get(4)?)),
            )
            .optional()?)
    }

    /// Every session a filter matches, most recently active first, with the
    /// unit its history was last read from. The filter's search, order and
    /// window do not apply: this is every match, for reading each one's
    /// history.
    pub(crate) fn origins(&self, filter: &Filter) -> Result<Vec<Origin>> {
        let Listing {
            rows,
            models,
            bindings,
        } = self.listing(&Filter {
            search: None,
            ..filter.clone()
        })?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {SESSION}, {models}, agent, page.path, mtime, size
             FROM (SELECT * FROM {rows}) AS page LEFT JOIN files ON files.path = page.path
             ORDER BY updated_at DESC, id"
        ))?;
        let origins = statement.query_map(params_from_iter(&bindings), |row| {
            Ok(Origin {
                session: read_session(row)?,
                unit: read_unit(row, 21)?,
            })
        })?;
        Ok(origins.collect::<rusqlite::Result<_>>()?)
    }

    /// Models ranked by the usage recorded within a period, each with its
    /// usage by local day.
    pub fn models(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<ModelUsage>> {
        let within = self.within(since, until)?;
        let mut models: Vec<ModelUsage> = self
            .connection
            .prepare(&format!(
                "SELECT model, GROUP_CONCAT(DISTINCT agent), COUNT(DISTINCT session_id), {SUMS}
                 FROM usage WHERE model <> '' AND {within}
                 GROUP BY model ORDER BY total DESC"
            ))?
            .query_map([], |row| {
                let keys = row.get_ref(1)?.as_str()?;
                Ok(ModelUsage {
                    model: row.get(0)?,
                    // In the interface's order, whichever order they were read in.
                    agents: Agent::ALL
                        .into_iter()
                        .filter(|agent| keys.split(',').any(|key| key == agent.key()))
                        .collect(),
                    sessions: row.get(2)?,
                    tokens: read_tokens(row, 3)?,
                    cost_usd: row.get(9)?,
                    daily: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let ranks: HashMap<String, usize> = models
            .iter()
            .enumerate()
            .map(|(rank, model)| (model.model.clone(), rank))
            .collect();
        let mut days = self.connection.prepare(&format!(
            "SELECT model, {LOCAL_DAY} AS day, SUM(total), SUM(cost_usd)
             FROM usage WHERE model <> '' AND {within}
             GROUP BY model, day ORDER BY day"
        ))?;
        let mut rows = days.query([])?;
        while let Some(row) = rows.next()? {
            let model = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
            if let Some(&rank) = ranks.get(model) {
                models[rank].daily.push(ModelDay {
                    day: row.get(1)?,
                    tokens: row.get(2)?,
                    cost_usd: row.get(3)?,
                });
            }
        }
        Ok(models)
    }

    /// Projects, the directories sessions worked in, ranked by the usage
    /// recorded in them within a period. A session that recorded no directory
    /// is in none.
    pub fn projects(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<ProjectUsage>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT cwd, COUNT(DISTINCT session_id), {SUMS}
             FROM usage JOIN (SELECT id, cwd FROM sessions) ON id = session_id
             WHERE cwd IS NOT NULL AND {within}
             GROUP BY cwd ORDER BY total DESC",
            within = self.within(since, until)?,
        ))?;
        let rows = statement.query_map([], |row| {
            Ok(ProjectUsage {
                project: row.get(0)?,
                sessions: row.get(1)?,
                tokens: read_tokens(row, 2)?,
                cost_usd: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Totals for the overview, and for each local day, within a period.
    ///
    /// Sessions are those that used tokens in the period, and tokens and cost
    /// what they used within it. Days are this machine's, which is also the
    /// reader's.
    pub fn overview(&self, since: Option<i64>, until: Option<i64>) -> Result<Overview> {
        let within = self.within(since, until)?;
        let by_agent: Vec<AgentTotals> = self
            .connection
            .prepare(&format!(
                "SELECT agent, COUNT(DISTINCT session_id), {SUMS} FROM usage WHERE {within}
                 GROUP BY agent ORDER BY total DESC"
            ))?
            .query_map([], |row| {
                Ok(AgentTotals {
                    agent: row.get(0)?,
                    sessions: row.get(1)?,
                    tokens: read_tokens(row, 2)?,
                    cost_usd: row.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut whole = Sum::default();
        for agent in &by_agent {
            whole.add(agent.sessions, agent.tokens, agent.cost_usd);
        }
        let daily = self
            .spans(LOCAL_DAY, &within)?
            .into_iter()
            .map(|(day, (sum, by_agent))| DayTotals {
                day,
                sessions: sum.sessions,
                tokens: sum.tokens,
                cost_usd: sum.cost_usd,
                by_agent,
            })
            .collect();
        Ok(Overview {
            sessions: whole.sessions,
            tokens: whole.tokens,
            cost_usd: whole.cost_usd,
            by_agent,
            daily,
        })
    }

    /// Totals for each local hour of a period that had any usage, oldest
    /// first. Hours are this machine's, as days are.
    pub(crate) fn hours(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<HourTotals>> {
        Ok(self
            .spans(LOCAL_HOUR, &self.within(since, until)?)?
            .into_iter()
            .map(|(hour, (sum, by_agent))| HourTotals {
                hour,
                sessions: sum.sessions,
                tokens: sum.tokens,
                cost_usd: sum.cost_usd,
                by_agent,
            })
            .collect())
    }

    /// The usage rows `within` chooses, in spans of local time by the instant
    /// each starts, each summed and split by agent. `start` is [`LOCAL_DAY`]
    /// or [`LOCAL_HOUR`].
    fn spans(&self, start: &str, within: &str) -> Result<BTreeMap<i64, (Sum, Vec<AgentDay>)>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {start} AS span, agent, COUNT(DISTINCT session_id), {SUMS}
             FROM usage WHERE {within}
             GROUP BY span, agent ORDER BY span, agent"
        ))?;
        let mut spans: BTreeMap<i64, (Sum, Vec<AgentDay>)> = BTreeMap::new();
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let (tokens, cost_usd) = (read_tokens(row, 3)?, row.get(9)?);
            let (sum, by_agent) = spans.entry(row.get(0)?).or_default();
            sum.add(row.get(2)?, tokens, cost_usd);
            by_agent.push(AgentDay {
                agent: row.get(1)?,
                tokens: tokens.total,
                cost_usd,
            });
        }
        Ok(spans)
    }

    /// The sessions `filter` matches, as SQL. What the caller wrote is bound,
    /// never written into the statement; the agents and the period's instants
    /// are, which cannot hold caller text.
    fn listing(&self, filter: &Filter) -> Result<Listing> {
        let mut clauses = vec!["TRUE".to_owned()];
        let mut bindings = Vec::new();
        if !filter.include_spawned {
            clauses.push("spawned = 0".to_owned());
        }
        if let Some(search) = filter
            .search
            .as_deref()
            .map(str::trim)
            .filter(|search| !search.is_empty())
        {
            // Escaped, `%` and `_` match themselves rather than any text.
            let search = search
                .replace('\\', r"\\")
                .replace('%', r"\%")
                .replace('_', r"\_");
            bindings.push(Value::Text(format!("%{search}%")));
            let n = bindings.len();
            clauses.push(format!(
                r"(title LIKE ?{n} ESCAPE '\' OR cwd LIKE ?{n} ESCAPE '\'
                   OR EXISTS (SELECT 1 FROM usage
                              WHERE session_id = listed.id AND model LIKE ?{n} ESCAPE '\'))"
            ));
        }
        if !filter.agents.is_empty() {
            let keys: Vec<String> = filter
                .agents
                .iter()
                .map(|agent| format!("'{}'", agent.key()))
                .collect();
            clauses.push(format!("agent IN ({})", keys.join(", ")));
        }
        if let Some(project) = &filter.project {
            bindings.push(Value::Text(project.clone()));
            clauses.push(format!("cwd = ?{}", bindings.len()));
        }
        if let Some(model) = &filter.model {
            bindings.push(Value::Text(model.clone()));
            clauses.push(format!(
                "EXISTS (SELECT 1 FROM usage WHERE session_id = listed.id AND model = ?{})",
                bindings.len()
            ));
        }

        let (relation, models) = if filter.since.is_none() && filter.until.is_none() {
            ("sessions".to_owned(), "models".to_owned())
        } else {
            let within = self.within(filter.since, filter.until)?;
            let relation = format!(
                "(SELECT id, agent, native_id, title, cwd, branch, started_at, updated_at,
                         spawned, role, used.input, used.output, used.cache_read,
                         used.cache_write, used.reasoning, used.total AS total_tokens,
                         used.cost_usd, messages, tools, present, path
                  FROM sessions
                  JOIN (SELECT session_id, {SUMS} FROM usage WHERE {within}
                        GROUP BY session_id) AS used ON used.session_id = id)"
            );
            (
                relation,
                shares(&format!("session_id = page.id AND {within}")),
            )
        };
        Ok(Listing {
            rows: format!("{relation} AS listed WHERE {}", clauses.join(" AND ")),
            models,
            bindings,
        })
    }

    /// The condition choosing the usage rows within a period: a range of their
    /// instants, or nothing when the period holds all the usage there is.
    ///
    /// Instants are written into the statement rather than bound, which an
    /// integer allows. A range closed at both ends is what leads the planner
    /// to the usage index, so an open end is closed at the last usage or the
    /// first; a range holding all of them would read every row through the
    /// index, which is slower than reading the table.
    fn within(&self, since: Option<i64>, until: Option<i64>) -> Result<String> {
        let extent: (Option<i64>, Option<i64>) = self.connection.query_row(
            "SELECT (SELECT MIN(at) FROM usage), (SELECT MAX(at) FROM usage)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (Some(first), Some(last)) = extent else {
            return Ok("TRUE".to_owned());
        };
        let from = since.map_or(first, |since| since.max(first));
        let to = until.map_or(last, |until| until.min(last));
        Ok(if (from, to) == (first, last) {
            "TRUE".to_owned()
        } else {
            format!("at BETWEEN {from} AND {to}")
        })
    }

    /// Every subscription's last successfully read limits.
    pub(crate) fn accounts(&self) -> Result<Vec<Account>> {
        let mut statement = self.connection.prepare("SELECT account FROM accounts")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            // An account this version cannot read is dropped; the next refresh
            // replaces it.
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect())
    }

    /// When each provider last served usage, as the end of the quarter hour it
    /// was in, by the name agents give the provider.
    pub(crate) fn last_used(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self.connection.prepare(
            "SELECT provider, MAX(at) + ?1 FROM usage WHERE provider <> '' GROUP BY provider",
        )?;
        let rows = statement.query_map([QUARTER_HOUR], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// How many sessions the index holds.
    pub(crate) fn count(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?)
    }
}

/// The sessions a filter matches, as SQL.
struct Listing {
    /// A `FROM` and `WHERE` choosing the matching rows, as `listed`, which
    /// have the columns of the sessions table. Within a period they are the
    /// sessions that used tokens in it, carrying that usage in place of their
    /// whole, and have no `models`.
    rows: String,
    /// The expression for a row's model shares, over it as `page`.
    models: String,
    /// What the placeholders in `rows` bind.
    bindings: Vec<Value>,
}

/// The column a sort key orders on. Each has an index, so no ordering the list
/// offers sorts the whole table.
fn sort_column(key: SortKey) -> &'static str {
    match key {
        SortKey::Updated => "updated_at",
        SortKey::Started => "started_at",
        SortKey::Tokens => "total_tokens",
        SortKey::Cost => "cost_usd",
        SortKey::Title => "title",
    }
}

/// A scalar subquery for the usage rows `condition` chooses, by model and
/// largest first, as the JSON a session's `models` column holds.
///
/// Usage recorded under no model counts toward a session but is no model's,
/// so it has no share.
fn shares(condition: &str) -> String {
    format!(
        "(SELECT json_group_array(json_object(
                     'model', model,
                     'tokens', json_object(
                         'input', input, 'output', output,
                         'cacheRead', cache_read, 'cacheWrite', cache_write,
                         'reasoning', reasoning, 'total', total),
                     'costUsd', cost_usd))
          FROM (SELECT model, {SUMS} FROM usage WHERE {condition} AND model <> ''
                GROUP BY model ORDER BY total DESC))"
    )
}

/// Sessions, tokens and cost added up across agents.
#[derive(Default)]
struct Sum {
    sessions: i64,
    tokens: Tokens,
    cost_usd: Option<f64>,
}

impl Sum {
    /// Add one agent's share. A session belongs to one agent, so the agents'
    /// counts of sessions add up.
    fn add(&mut self, sessions: i64, tokens: Tokens, cost_usd: Option<f64>) {
        self.sessions += sessions;
        self.tokens.add(tokens);
        if let Some(cost) = cost_usd {
            *self.cost_usd.get_or_insert(0.0) += cost;
        }
    }
}

/// An agent is stored as its key.
impl ToSql for Agent {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.key().into())
    }
}

impl FromSql for Agent {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        Agent::from_key(value.as_str()?).ok_or(FromSqlError::InvalidType)
    }
}

/// A session from the columns [`SESSION`] names, then its model shares.
fn read_session(row: &Row) -> rusqlite::Result<Session> {
    let models = row.get_ref(20)?.as_str()?;
    Ok(Session {
        id: row.get(0)?,
        agent: row.get(1)?,
        native_id: row.get(2)?,
        title: row.get(3)?,
        cwd: row.get(4)?,
        branch: row.get(5)?,
        started_at: row.get(6)?,
        updated_at: row.get(7)?,
        spawned: row.get(8)?,
        role: row.get(9)?,
        tokens: read_tokens(row, 10)?,
        cost_usd: row.get(16)?,
        messages: row.get(17)?,
        tools: row.get(18)?,
        present: row.get(19)?,
        models: serde_json::from_str(models).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(20, Type::Text, error.into())
        })?,
    })
}

/// The six token columns from `first` on, in the order [`Tokens`] declares
/// them: input, output, cache read, cache write, reasoning, total.
fn read_tokens(row: &Row, first: usize) -> rusqlite::Result<Tokens> {
    Ok(Tokens {
        input: row.get(first)?,
        output: row.get(first + 1)?,
        cache_read: row.get(first + 2)?,
        cache_write: row.get(first + 3)?,
        reasoning: row.get(first + 4)?,
        total: row.get(first + 5)?,
    })
}

/// A unit from its agent, path, and the modification time and size its file
/// had when last read, from column `first` on. A file since gone has no
/// signature, and reads as zero.
fn read_unit(row: &Row, first: usize) -> rusqlite::Result<Unit> {
    Ok(Unit {
        agent: row.get(first)?,
        path: PathBuf::from(row.get::<_, String>(first + 1)?),
        mtime: row.get::<_, Option<i64>>(first + 2)?.unwrap_or_default(),
        size: row.get::<_, Option<i64>>(first + 3)?.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Sort;
    use crate::source::Usage;

    const DAY: i64 = 86_400_000;

    fn memory() -> Store {
        Store::open(Path::new(":memory:")).expect("opens")
    }

    /// Usage under the fixtures' one model, at one instant.
    fn usage(at: i64, total: i64) -> Usage {
        Usage {
            at,
            provider: "anthropic".into(),
            model: "model-a".into(),
            tokens: Tokens {
                total,
                ..Tokens::default()
            },
            cost_usd: Some(1.5),
        }
    }

    /// A session that used `total` tokens, all at its last activity.
    fn summary(id: &str, agent: Agent, updated: i64, total: i64, spawned: bool) -> Summary {
        Summary {
            session: Session {
                id: format!("{}:{id}", agent.key()),
                agent,
                native_id: id.into(),
                title: Some(format!("Session {id}")),
                cwd: Some("/w/proj".into()),
                branch: None,
                started_at: updated - 1_000,
                updated_at: updated,
                spawned,
                role: None,
                models: Vec::new(),
                tokens: Tokens::default(),
                cost_usd: None,
                messages: None,
                tools: None,
                present: true,
            },
            usage: vec![usage(updated, total)],
        }
    }

    fn unit(path: &str) -> Unit {
        Unit {
            agent: Agent::Codex,
            path: PathBuf::from(path),
            mtime: 10,
            size: 20,
        }
    }

    /// Two Codex sessions in one file, and two Claude Code sessions in
    /// another, the newest of them spawned.
    fn filled() -> Store {
        let mut store = memory();
        store
            .put(
                &unit("/a.jsonl"),
                &[
                    summary("one", Agent::Codex, 3_000, 300, false),
                    summary("two", Agent::Codex, 1_000, 100, false),
                ],
            )
            .expect("writes");
        store
            .put(
                &unit("/b.jsonl"),
                &[
                    summary("three", Agent::ClaudeCode, 2_000, 200, false),
                    summary("four", Agent::ClaudeCode, 4_000, 400, true),
                ],
            )
            .expect("writes");
        store
    }

    /// The list a filter asks for, from as many rows as there are.
    fn page(store: &Store, filter: Filter) -> SessionPage {
        store
            .list(&Filter {
                limit: filter.limit.max(50),
                ..filter
            })
            .expect("lists")
    }

    /// The native ids of a page's rows, in order.
    fn listed(page: &SessionPage) -> Vec<&str> {
        let ids = page
            .sessions
            .iter()
            .map(|session| session.native_id.as_str());
        ids.collect()
    }

    #[test]
    fn the_list_hides_spawned_runs_unless_asked() {
        let store = filled();
        let own = page(&store, Filter::default());
        assert_eq!(listed(&own), ["two", "three", "one"], "least recent first");
        assert_eq!(own.total, 3);

        let all = Filter {
            include_spawned: true,
            ..Filter::default()
        };
        assert_eq!(page(&store, all).total, 4);
    }

    #[test]
    fn a_list_narrows_to_one_project_one_model_or_some_agents() {
        let mut store = filled();
        let mut elsewhere = summary("five", Agent::Codex, 5_000, 500, false);
        elsewhere.session.cwd = Some("/w/other".into());
        elsewhere.usage[0].model = "model-b".into();
        store.put(&unit("/c.jsonl"), &[elsewhere]).expect("writes");

        let count = |filter: Filter| page(&store, filter).total;
        let in_project = |project: &str| {
            count(Filter {
                project: Some(project.into()),
                ..Filter::default()
            })
        };
        assert_eq!(in_project("/w/proj"), 3);
        assert_eq!(in_project("/w/other"), 1);
        assert_eq!(in_project("/w"), 0, "a project is matched whole");

        let using = |model: &str| {
            count(Filter {
                model: Some(model.into()),
                ..Filter::default()
            })
        };
        assert_eq!(using("model-a"), 3);
        assert_eq!(using("model-b"), 1);
        assert_eq!(using("model"), 0, "a model is matched whole");

        let of = |agents: Vec<Agent>| {
            count(Filter {
                agents,
                include_spawned: true,
                ..Filter::default()
            })
        };
        assert_eq!(of(vec![Agent::Codex]), 3);
        assert_eq!(of(vec![Agent::Codex, Agent::ClaudeCode]), 5);
        assert_eq!(of(vec![Agent::Pi]), 0);
    }

    #[test]
    fn totals_cover_the_whole_match_not_the_page() {
        let store = filled();
        let first = store
            .list(&Filter {
                include_spawned: true,
                limit: 1,
                ..Filter::default()
            })
            .expect("lists");
        assert_eq!(first.sessions.len(), 1, "one row was asked for");
        assert_eq!(first.total, 4, "but the count covers every match");
        // 300 + 100 + 200 + 400, at 1.5 each.
        assert_eq!(first.tokens.total, 1_000);
        assert_eq!(first.cost_usd, Some(6.0));

        let none = page(
            &store,
            Filter {
                search: Some("no such thing".into()),
                ..Filter::default()
            },
        );
        assert_eq!(
            (none.total, none.tokens, none.cost_usd),
            (0, Tokens::default(), None)
        );
    }

    #[test]
    fn every_sort_key_orders_both_ways() {
        let store = filled();
        let sorted = |key, descending| {
            let filter = Filter {
                include_spawned: true,
                sort: Sort { key, descending },
                ..Filter::default()
            };
            let page = page(&store, filter);
            listed(&page)
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        // Four was updated, started and titled after the others and used the
        // most, and two before them and the least; "Session four" is first
        // alphabetically.
        let largest_first = ["four", "one", "three", "two"];
        let smallest_first = ["two", "three", "one", "four"];
        for key in [SortKey::Updated, SortKey::Started, SortKey::Tokens] {
            assert_eq!(sorted(key, true), largest_first, "{key:?}");
            assert_eq!(sorted(key, false), smallest_first, "{key:?}");
        }
        assert_eq!(sorted(SortKey::Title, false), largest_first);
        assert_eq!(sorted(SortKey::Title, true), smallest_first);
        // Every session cost the same, so the id settles the order either way.
        for descending in [true, false] {
            assert_eq!(
                sorted(SortKey::Cost, descending),
                ["four", "three", "one", "two"]
            );
        }
    }

    #[test]
    fn paging_walks_the_whole_result_once_within_bounds() {
        let store = filled();
        let at = |offset: i64, limit: i64| {
            let filter = Filter {
                include_spawned: true,
                offset,
                limit,
                ..Filter::default()
            };
            let page = store.list(&filter).expect("lists");
            listed(&page)
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let walked: Vec<String> = (0..4).flat_map(|offset| at(offset, 1)).collect();
        assert_eq!(walked, ["two", "three", "one", "four"]);
        assert!(at(4, 1).is_empty(), "past the end is empty");
        assert_eq!(at(-3, 1), ["two"], "before the start is the start");
        assert_eq!(at(0, 10_000).len(), 4, "a page is bounded by what exists");
        assert_eq!(at(0, 0).len(), 1, "and holds at least one row");
    }

    #[test]
    fn search_matches_title_directory_and_model() {
        let store = filled();
        let matching = |search: &str| {
            let filter = Filter {
                search: Some(search.into()),
                include_spawned: true,
                ..Filter::default()
            };
            page(&store, filter).total
        };
        assert_eq!(matching("  Session one "), 1);
        assert_eq!(matching("W/PROJ"), 4, "ignoring case");
        assert_eq!(matching("model-a"), 4);
        assert_eq!(matching("no such thing"), 0);
        // The model shares are also kept as JSON on the row, so a search that
        // reached that JSON would match its field names in every session.
        for structural in ["tokens", "costUsd", "cacheRead", "model\":"] {
            assert_eq!(matching(structural), 0, "{structural}");
        }
    }

    #[test]
    fn a_search_matches_what_was_written() {
        let mut store = filled();
        let mut literal = summary("five", Agent::Codex, 5_000, 500, false);
        literal.session.title = Some("Cut 50% of snake_case".into());
        store.put(&unit("/c.jsonl"), &[literal]).expect("writes");
        let matching = |search: &str| {
            let filter = Filter {
                search: Some(search.into()),
                include_spawned: true,
                ..Filter::default()
            };
            listed(&page(&store, filter)).join(" ")
        };
        assert_eq!(matching("50%"), "five");
        assert_eq!(matching("e_c"), "five");
        // As wildcards, these would match "Session one", "Session four" and
        // every other title.
        assert_eq!(matching("n%o"), "");
        assert_eq!(matching("Sessio_"), "");
        assert_eq!(matching(r"\"), "");
        // SQL is bound as text, not run.
        assert_eq!(matching("'; DROP TABLE sessions; --"), "");
        assert_eq!(store.count().expect("counts"), 5);
    }

    #[test]
    fn re_reading_a_unit_replaces_rather_than_duplicates() {
        let mut store = filled();
        let mut changed = summary("one", Agent::Codex, 9_999, 999, false);
        // The same file, grown: it starts where it did.
        changed.session.started_at = 2_000;
        changed.session.title = Some("Renamed".into());
        store.put(&unit("/a.jsonl"), &[changed]).expect("writes");

        assert_eq!(store.count().expect("counts"), 4, "no duplicate row");
        let found = store.get("codex:one").expect("reads").expect("exists");
        assert_eq!(found.title.as_deref(), Some("Renamed"));
        assert_eq!(found.tokens.total, 999);
        // 1_000 - 300 + 999: the old usage is replaced, not added to.
        let overview = store.overview(None, None).expect("totals");
        assert_eq!(overview.tokens.total, 1_699);
    }

    #[test]
    fn a_session_spanning_several_files_adds_their_usage() {
        let mut store = memory();
        // A thread resumed into a second file. Each file is read on its own,
        // and here the later one happens to be written first.
        let segment = |started: i64, updated: i64, title: &str, total: i64| {
            let mut read = summary("thread", Agent::Codex, updated, total, false);
            read.session.started_at = started;
            read.session.title = Some(title.into());
            read
        };
        let mut later = segment(8_000, 9_000, "Carry on", 40);
        later.usage.push(Usage {
            model: String::new(),
            ..usage(9_000, 5)
        });
        store
            .put(&unit("/sessions/rollout-2.jsonl"), &[later])
            .expect("writes");
        let earlier = segment(1_000, 2_000, "The opening prompt", 100);
        store
            .put(&unit("/sessions/rollout-1.jsonl"), &[earlier])
            .expect("writes");

        let thread = store.get("codex:thread").expect("reads").expect("exists");
        assert_eq!(thread.tokens.total, 145);
        assert_eq!(thread.title.as_deref(), Some("The opening prompt"));
        assert_eq!((thread.started_at, thread.updated_at), (1_000, 9_000));
        // Usage under no model counts toward the session but is no model's.
        let shares: Vec<_> = thread
            .models
            .iter()
            .map(|slice| (slice.model.as_str(), slice.tokens.total))
            .collect();
        assert_eq!(shares, [("model-a", 140)]);
        let (latest, _) = store
            .locate("codex:thread")
            .expect("reads")
            .expect("exists");
        assert_eq!(latest.path, PathBuf::from("/sessions/rollout-2.jsonl"));

        // Archiving moves a file; read again from there, it replaces its usage.
        let archived = segment(1_000, 2_000, "The opening prompt", 100);
        store
            .put(&unit("/archived_sessions/rollout-1.jsonl"), &[archived])
            .expect("writes");
        let thread = store.get("codex:thread").expect("reads").expect("exists");
        assert_eq!(thread.tokens.total, 145);
    }

    #[test]
    fn a_session_spanning_several_files_is_the_same_whichever_is_read_last() {
        // A spawned thread resumed into a second file in another directory. The
        // second recorded no branch or role, nor that the thread was spawned.
        let mut earlier = summary("thread", Agent::Codex, 2_000, 100, true);
        earlier.session.cwd = Some("/w/before".into());
        earlier.session.branch = Some("main".into());
        earlier.session.role = Some("thread_spawn".into());
        let mut later = summary("thread", Agent::Codex, 9_000, 40, false);
        later.session.cwd = Some("/w/after".into());
        let files = [
            ("/sessions/rollout-1.jsonl", &earlier),
            ("/sessions/rollout-2.jsonl", &later),
        ];

        for order in [[files[0], files[1]], [files[1], files[0]]] {
            let mut store = memory();
            for (path, read) in order {
                store
                    .put(&unit(path), std::slice::from_ref(read))
                    .expect("writes");
            }
            let thread = store.get("codex:thread").expect("reads").expect("exists");
            assert_eq!(
                thread.cwd.as_deref(),
                Some("/w/after"),
                "the directory it was last worked in"
            );
            assert_eq!(
                (thread.branch.as_deref(), thread.role.as_deref()),
                (Some("main"), Some("thread_spawn")),
                "what the latest file did not record, an earlier one did"
            );
            assert!(
                thread.spawned,
                "a continuation does not unmark a spawned run"
            );
            let projects: Vec<_> = store
                .projects(None, None)
                .expect("ranks")
                .into_iter()
                .map(|project| (project.project, project.tokens.total))
                .collect();
            assert_eq!(projects, [("/w/after".to_owned(), 140)]);
        }
    }

    #[test]
    fn counts_learned_by_reading_survive_a_rescan() {
        let mut store = filled();
        store
            .put_counts("codex:one", 42, 17)
            .expect("writes counts");
        // A rescan summarizes the unit again, which knows nothing of counts.
        store
            .put(
                &unit("/a.jsonl"),
                &[summary("one", Agent::Codex, 3_000, 300, false)],
            )
            .expect("writes");

        let found = store.get("codex:one").expect("reads").expect("exists");
        assert_eq!((found.messages, found.tools), (Some(42), Some(17)));
    }

    #[test]
    fn retiring_a_file_forgets_it_but_keeps_its_sessions_marked_absent() {
        let mut store = filled();
        let signatures = store.signatures().expect("reads");
        assert_eq!(signatures.len(), 2);
        assert_eq!(signatures.get("/a.jsonl"), Some(&(10, 20)));

        store.retire(&["/a.jsonl".into()]).expect("retires");
        let found = store.get("codex:one").expect("reads").expect("still there");
        assert!(!found.present, "the history is kept, flagged as gone");
        assert!(
            !store.signatures().expect("reads").contains_key("/a.jsonl"),
            "but the file is no longer tracked, so it can be found again"
        );
    }

    #[test]
    fn locating_a_session_names_its_file_and_native_id() {
        let mut store = filled();
        let (unit, native_id) = store.locate("codex:one").expect("reads").expect("exists");
        assert_eq!(
            (
                unit.agent,
                unit.path,
                unit.mtime,
                unit.size,
                native_id.as_str()
            ),
            (Agent::Codex, PathBuf::from("/a.jsonl"), 10, 20, "one")
        );
        assert!(store.locate("codex:missing").expect("reads").is_none());

        // A file since gone has no signature, but its session is still where
        // it was.
        store.retire(&["/a.jsonl".into()]).expect("retires");
        let (gone, _) = store.locate("codex:one").expect("reads").expect("exists");
        assert_eq!(
            (gone.path, gone.mtime, gone.size),
            (PathBuf::from("/a.jsonl"), 0, 0)
        );
    }

    #[test]
    fn origins_are_every_match_newest_first_with_where_each_was_read() {
        let store = filled();
        let origins = |filter: Filter| {
            let found = store.origins(&filter).expect("finds");
            let found = found.into_iter().map(|origin| {
                let unit = origin.unit;
                (origin.session.native_id, unit.agent, unit.path, unit.size)
            });
            found.collect::<Vec<_>>()
        };
        let expected = |rows: &[(&str, Agent, &str)]| {
            let rows = rows
                .iter()
                .map(|&(id, agent, path)| (id.to_owned(), agent, PathBuf::from(path), 20));
            rows.collect::<Vec<_>>()
        };
        // A search, an order and a window do not narrow it.
        let every = origins(Filter {
            search: Some("no such thing".into()),
            sort: Sort {
                key: SortKey::Title,
                descending: false,
            },
            offset: 2,
            limit: 1,
            ..Filter::default()
        });
        assert_eq!(
            every,
            expected(&[
                ("one", Agent::Codex, "/a.jsonl"),
                ("three", Agent::ClaudeCode, "/b.jsonl"),
                ("two", Agent::Codex, "/a.jsonl"),
            ])
        );
        // Everything else does, as it narrows the list.
        let recent = origins(Filter {
            since: Some(2_500),
            include_spawned: true,
            ..Filter::default()
        });
        assert_eq!(
            recent,
            expected(&[
                ("four", Agent::ClaudeCode, "/b.jsonl"),
                ("one", Agent::Codex, "/a.jsonl"),
            ])
        );
    }

    #[test]
    fn models_rank_by_recorded_usage_and_split_it_by_day() {
        let mut store = memory();
        let mut multi = summary("m1", Agent::ClaudeCode, DAY + 5_000, 0, false);
        multi.usage = vec![
            Usage {
                model: "haiku".into(),
                cost_usd: None,
                ..usage(5_000, 50)
            },
            Usage {
                model: "opus".into(),
                cost_usd: Some(2.0),
                ..usage(5_000, 250)
            },
            Usage {
                model: "opus".into(),
                cost_usd: Some(0.5),
                ..usage(DAY + 5_000, 60)
            },
        ];
        store.put(&unit("/m.jsonl"), &[multi]).expect("writes");

        let ranked = store.models(None, None).expect("ranks");
        let summary: Vec<_> = ranked
            .iter()
            .map(|model| {
                (
                    model.model.as_str(),
                    model.tokens.total,
                    model.cost_usd,
                    model.sessions,
                    model.agents.clone(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("opus", 310, Some(2.5), 1, vec![Agent::ClaudeCode]),
                ("haiku", 50, None, 1, vec![Agent::ClaudeCode]),
            ],
            "unpriced is not free"
        );
        // A day apart, the two uses of opus fall on two local days.
        let daily: Vec<_> = ranked[0]
            .daily
            .iter()
            .map(|day| (day.tokens, day.cost_usd))
            .collect();
        assert_eq!(daily, [(250, Some(2.0)), (60, Some(0.5))]);
        assert_eq!(ranked[1].daily.len(), 1);

        // The session's own shares come largest first too.
        let session = store.get("claude_code:m1").expect("reads").expect("exists");
        let shares: Vec<_> = session
            .models
            .iter()
            .map(|slice| (slice.model.as_str(), slice.cost_usd))
            .collect();
        assert_eq!(shares, [("opus", Some(2.5)), ("haiku", None)]);
        assert_eq!(session.cost_usd, Some(2.5));
    }

    #[test]
    fn a_models_agents_are_in_the_interfaces_order() {
        let mut store = memory();
        // Grok's is written first, and its key sorts first too.
        for (path, agent) in [
            ("/g.jsonl", Agent::GrokBuild),
            ("/o.jsonl", Agent::OpenCode),
        ] {
            let used = summary("s", agent, 1_000, 10, false);
            store.put(&unit(path), &[used]).expect("writes");
        }
        let ranked = store.models(None, None).expect("ranks");
        assert_eq!(ranked[0].agents, [Agent::OpenCode, Agent::GrokBuild]);
    }

    #[test]
    fn projects_rank_by_the_usage_recorded_in_their_directory() {
        let mut store = filled();
        let mut elsewhere = summary("five", Agent::Codex, 5_000, 500, false);
        elsewhere.session.cwd = Some("/w/other".into());
        let mut nowhere = summary("six", Agent::Codex, 6_000, 600, false);
        nowhere.session.cwd = None;
        store
            .put(&unit("/c.jsonl"), &[elsewhere, nowhere])
            .expect("writes");

        let ranked = |since| {
            let projects = store.projects(since, None).expect("ranks").into_iter();
            let ranked = projects.map(|project| {
                (
                    project.project,
                    project.sessions,
                    project.tokens.total,
                    project.cost_usd,
                )
            });
            ranked.collect::<Vec<_>>()
        };
        // 300 + 100 + 200 + 400 in /w/proj and 500 in /w/other, each priced at
        // 1.5. The 600 with no directory is in neither.
        assert_eq!(
            ranked(None),
            [
                ("/w/proj".to_owned(), 4, 1_000, Some(6.0)),
                ("/w/other".to_owned(), 1, 500, Some(1.5)),
            ]
        );
        // From 3,500 on, only four's 400 and five's 500 were used.
        assert_eq!(
            ranked(Some(3_500)),
            [
                ("/w/other".to_owned(), 1, 500, Some(1.5)),
                ("/w/proj".to_owned(), 1, 400, Some(1.5)),
            ]
        );
    }

    #[test]
    fn a_period_counts_only_the_usage_inside_it() {
        let mut store = memory();
        // A session that used 100 tokens on its first day and 40 on its second.
        let mut spanning = summary("span", Agent::Codex, DAY + DAY / 2, 140, false);
        spanning.usage = vec![usage(DAY / 2, 100), usage(DAY + DAY / 2, 40)];
        store.put(&unit("/s.jsonl"), &[spanning]).expect("writes");

        let second = store.overview(Some(DAY), None).expect("totals");
        assert_eq!(second.tokens.total, 40, "the first day's usage is outside");
        assert_eq!(second.sessions, 1, "but the session used tokens in it");
        assert_eq!(second.daily.len(), 1);
        let models = store.models(Some(DAY), None).expect("ranks");
        assert_eq!((models[0].tokens.total, models[0].sessions), (40, 1));
        assert!(store.models(Some(2 * DAY), None).expect("ranks").is_empty());

        // The list narrows the same way, by when tokens were used, and counts
        // the same usage.
        let listed = |since, until| {
            let filter = Filter {
                since,
                until,
                ..Filter::default()
            };
            page(&store, filter)
        };
        let later = listed(Some(DAY), None);
        assert_eq!(later.total, 1);
        assert_eq!((later.tokens.total, later.cost_usd), (40, Some(1.5)));
        let row = &later.sessions[0];
        assert_eq!((row.tokens.total, row.cost_usd), (40, Some(1.5)));
        assert_eq!(row.models[0].tokens.total, 40);
        let first = listed(None, Some(DAY - 1));
        assert_eq!(first.sessions[0].tokens.total, 100, "a period can end, too");
        let both = listed(Some(DAY / 2), Some(DAY + DAY / 2));
        assert_eq!(both.sessions[0].tokens.total, 140, "and holds its ends");
        assert_eq!(
            listed(Some(2 * DAY), None).total,
            0,
            "nothing was used after"
        );
        assert_eq!(listed(None, Some(DAY / 2 - 1)).total, 0, "nor before");

        let all = store.overview(None, None).expect("totals");
        let days: Vec<_> = all.daily.iter().map(|day| day.tokens.total).collect();
        assert_eq!(days, [100, 40]);
        // The session itself is still the whole of it.
        let whole = store.get("codex:span").expect("reads").expect("exists");
        assert_eq!((whole.tokens.total, whole.cost_usd), (140, Some(3.0)));
    }

    #[test]
    fn a_period_orders_and_totals_the_list_by_what_was_used_in_it() {
        let mut store = memory();
        let used = |at, total, cost| Usage {
            cost_usd: Some(cost),
            ..usage(at, total)
        };
        // One session did most of its work on the first day and little on the
        // second; the other did all of its on the second, under two models.
        let mut busy = summary("busy", Agent::Codex, DAY + DAY / 2, 0, false);
        busy.usage = vec![used(DAY / 2, 1_000, 8.0), used(DAY + DAY / 2, 10, 0.25)];
        let mut late = summary("late", Agent::ClaudeCode, DAY + DAY / 2, 0, false);
        late.usage = vec![
            used(DAY + DAY / 2, 30, 0.5),
            Usage {
                model: "model-b".into(),
                ..used(DAY + DAY / 2, 20, 0.25)
            },
        ];
        store.put(&unit("/s.jsonl"), &[busy, late]).expect("writes");

        let list = |filter: Filter| page(&store, filter);
        let ranked = |page: &SessionPage| -> Vec<(String, i64)> {
            page.sessions
                .iter()
                .map(|session| (session.native_id.clone(), session.tokens.total))
                .collect()
        };
        let largest = |key| Sort {
            key,
            descending: true,
        };

        let ever = list(Filter {
            sort: largest(SortKey::Tokens),
            ..Filter::default()
        });
        assert_eq!(ranked(&ever), [("busy".into(), 1_010), ("late".into(), 50)]);

        let second = list(Filter {
            since: Some(DAY),
            sort: largest(SortKey::Tokens),
            ..Filter::default()
        });
        assert_eq!(
            ranked(&second),
            [("late".into(), 50), ("busy".into(), 10)],
            "the period's largest, not the largest that touched it"
        );
        let by_cost = list(Filter {
            since: Some(DAY),
            sort: largest(SortKey::Cost),
            ..Filter::default()
        });
        let costs: Vec<_> = by_cost
            .sessions
            .iter()
            .map(|session| (session.native_id.as_str(), session.cost_usd))
            .collect();
        assert_eq!(costs, [("late", Some(0.75)), ("busy", Some(0.25))]);
        let shares: Vec<_> = second
            .sessions
            .iter()
            .map(|session| {
                session
                    .models
                    .iter()
                    .map(|slice| (slice.model.as_str(), slice.tokens.total))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(
            shares,
            [
                vec![("model-a", 30), ("model-b", 20)],
                vec![("model-a", 10)]
            ]
        );

        // What the overview and the projects ranking say of the period is what
        // the list opened from them adds up to.
        let overview = store.overview(Some(DAY), None).expect("totals");
        assert_eq!(
            (second.total, second.tokens, second.cost_usd),
            (overview.sessions, overview.tokens, overview.cost_usd)
        );
        let projects = store.projects(Some(DAY), None).expect("ranks");
        let project = list(Filter {
            since: Some(DAY),
            project: Some(projects[0].project.clone()),
            ..Filter::default()
        });
        assert_eq!(
            (project.tokens, project.cost_usd),
            (projects[0].tokens, projects[0].cost_usd)
        );

        // Paging and narrowing work within a period as they do without one.
        let rest = store
            .list(&Filter {
                since: Some(DAY),
                sort: largest(SortKey::Tokens),
                offset: 1,
                limit: 1,
                ..Filter::default()
            })
            .expect("lists");
        assert_eq!(ranked(&rest), [("busy".into(), 10)]);
        let narrowed = list(Filter {
            since: Some(DAY),
            model: Some("model-b".into()),
            search: Some("late".into()),
            ..Filter::default()
        });
        assert_eq!(listed(&narrowed), ["late"]);
    }

    #[test]
    fn the_overview_totals_agree_with_its_parts() {
        let store = filled();
        let overview = store.overview(None, None).expect("totals");
        assert_eq!(overview.sessions, 4);
        assert_eq!(overview.tokens.total, 1_000);
        assert_eq!(overview.cost_usd, Some(6.0));
        let agents: Vec<_> = overview
            .by_agent
            .iter()
            .map(|agent| (agent.agent, agent.sessions, agent.tokens.total))
            .collect();
        assert_eq!(
            agents,
            [(Agent::ClaudeCode, 2, 600), (Agent::Codex, 2, 400)]
        );

        let daily: i64 = overview.daily.iter().map(|day| day.tokens.total).sum();
        assert_eq!(daily, overview.tokens.total, "all usage lands in a day");
        for day in &overview.daily {
            let shares: i64 = day.by_agent.iter().map(|share| share.tokens).sum();
            assert_eq!(shares, day.tokens.total, "a day's agents add up to it");
        }
    }

    #[test]
    fn days_break_at_local_midnight_even_beside_a_clock_change() {
        let mut store = memory();
        // Every three hours through the weeks North America and Europe change
        // their clocks: from 2026-03-01 for 35 days, and 2026-10-20 for 16.
        let every = |start: i64, days: i64| (0..days * 8).map(move |step| start + step * 10_800);
        let mut clock = summary("clock", Agent::Codex, 0, 0, false);
        clock.usage = every(1_772_323_200, 35)
            .chain(every(1_792_454_400, 16))
            .map(|seconds| usage(seconds * 1_000, 1))
            .collect();
        store.put(&unit("/c.jsonl"), &[clock]).expect("writes");

        let daily = store.overview(None, None).expect("totals").daily;
        let counted: i64 = daily.iter().map(|day| day.tokens.total).sum();
        assert_eq!(counted, 51 * 8, "every instant lands in a day");
        // In a zone that changes its clocks, a fixed offset would start the
        // days beside the change at 23:00 or 01:00.
        for day in &daily {
            let starts: String = store
                .connection
                .query_row(
                    "SELECT strftime('%H:%M', ?1 / 1000, 'unixepoch', 'localtime')",
                    [day.day],
                    |row| row.get(0),
                )
                .expect("formats");
            assert_eq!(starts, "00:00", "the day from {} ms", day.day);
        }
    }

    #[test]
    fn hours_are_whole_local_hours_even_beside_a_clock_change() {
        let mut store = memory();
        // Every quarter hour through the days North America and Europe change
        // their clocks in 2026: 8 and 29 March, 25 October and 1 November.
        let quarters = |from: i64, to: i64| (from..to).step_by(900).map(|seconds| seconds * 1_000);
        let spring = (1_772_841_600, 1_774_828_800); // 2026-03-07 to 2026-03-30, UTC
        let autumn = (1_792_281_600, 1_793_620_800); // 2026-10-18 to midday 2026-11-02, UTC
        let mut clock = summary("clock", Agent::Codex, 0, 0, false);
        clock.usage = quarters(spring.0, spring.1)
            .chain(quarters(autumn.0, autumn.1))
            .map(|at| usage(at, 1))
            .collect();
        let recorded: i64 = clock.usage.iter().map(|used| used.tokens.total).sum();
        store.put(&unit("/c.jsonl"), &[clock]).expect("writes");

        let hours = store.hours(None, None).expect("totals");
        let counted: i64 = hours.iter().map(|hour| hour.tokens.total).sum();
        assert_eq!(counted, recorded, "every quarter hour lands in an hour");

        // The ends of each run may start or stop part-way into a local hour.
        let within = |at: i64| {
            [spring, autumn]
                .iter()
                .any(|&(from, to)| (from * 1_000 + 3_600_000..to * 1_000 - 3_600_000).contains(&at))
        };
        for pair in hours.windows(2) {
            let (before, after) = (&pair[0], &pair[1]);
            if !within(before.hour) || !within(after.hour) {
                continue;
            }
            assert_eq!(
                after.hour - before.hour,
                3_600_000,
                "from {} ms",
                before.hour
            );
            // Grouping on the clock's reading would fold the hour repeated
            // when clocks go back into one of eight quarters.
            assert_eq!(after.tokens.total, 4, "the hour from {} ms", after.hour);
            let minutes: String = store
                .connection
                .query_row(
                    "SELECT strftime('%M', ?1 / 1000, 'unixepoch', 'localtime')",
                    [after.hour],
                    |row| row.get(0),
                )
                .expect("formats");
            assert_eq!(minutes, "00", "the hour from {} ms", after.hour);
        }
    }

    #[test]
    fn a_subscriptions_accounts_replace_only_what_was_kept_for_it() {
        let mut store = memory();
        let account = |id: &str, provider: Provider, read_at: Option<i64>| Account {
            id: id.into(),
            provider,
            label: None,
            plan: None,
            via: vec!["Pi".into()],
            limits: Vec::new(),
            read_at,
            problem: None,
            used_at: None,
        };
        let codex = |id, read_at| account(id, Provider::Codex, read_at);
        store
            .put_accounts(
                Provider::Codex,
                &[codex("codex:a", Some(1)), codex("codex:b", Some(1))],
            )
            .expect("writes");
        store
            .put_accounts(
                Provider::Grok,
                &[account("grok:c", Provider::Grok, Some(1))],
            )
            .expect("writes");
        // Account b has gone and account d was never read, so neither is kept;
        // Grok's account is another subscription's and is left alone.
        store
            .put_accounts(
                Provider::Codex,
                &[codex("codex:a", Some(2)), codex("codex:d", None)],
            )
            .expect("writes");

        let mut kept: Vec<_> = store
            .accounts()
            .expect("reads")
            .into_iter()
            .map(|account| (account.id, account.read_at))
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            [
                ("codex:a".to_owned(), Some(2)),
                ("grok:c".to_owned(), Some(1))
            ]
        );
    }

    #[test]
    fn an_index_of_another_shape_is_rebuilt_whatever_it_held() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("index.sqlite");
        {
            let old = Connection::open(&path).expect("creates");
            old.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO meta VALUES ('schema', '1');
                 CREATE TABLE sessions (id TEXT);
                 INSERT INTO sessions VALUES ('codex:old');
                 CREATE TABLE retired (id TEXT);",
            )
            .expect("an older index");
        }
        let store = Store::open(&path).expect("rebuilds");
        let retired: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'retired'",
                [],
                |row| row.get(0),
            )
            .expect("reads");
        assert_eq!(retired, 0, "a table this shape has no use for is gone");
        assert_eq!(store.count().expect("counts"), 0);
    }

    #[test]
    fn a_file_that_is_not_a_database_is_discarded_and_rebuilt() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("index.sqlite");
        let wal = directory.path().join("index.sqlite-wal");
        std::fs::write(&path, b"this is not a database, and it is long enough").expect("writes");
        // A journal left beside it would be replayed into the new index.
        std::fs::write(&wal, b"stale").expect("writes");
        let store = Store::open(&path).expect("rebuilds");
        assert_eq!(store.count().expect("counts"), 0);
        assert_ne!(std::fs::read(&wal).ok().as_deref(), Some(&b"stale"[..]));
    }
}
