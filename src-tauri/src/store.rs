//! The index.
//!
//! A single SQLite file holding one row per session, what each session used by
//! quarter hour, and the file signatures that make rescanning incremental. It
//! holds no transcript text: bodies stay in the agents' own files and are read
//! when a conversation is opened.
//!
//! # No migrations
//!
//! The index is a cache, not a record. Everything in it can be rebuilt from the
//! agents' files, so a schema change drops the tables and rebuilds rather than
//! migrating, and no store in the wild can have a shape a migration did not
//! expect.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;
use crate::session::{
    Account, Agent, AgentDay, AgentTotals, DayTotals, Filter, HourTotals, ModelDay, ModelSlice,
    ModelUsage, Overview, ProjectUsage, Provider, Session, SessionPage, Sort, SortKey, Tokens,
};
use crate::source::{Summary, Unit};

/// Bumped whenever the shape below or what a reader records changes, which
/// rebuilds the index.
const SCHEMA: i64 = 9;

/// The largest page the list will return, however much is asked for.
const MAX_PAGE: i64 = 500;

/// The local day a usage row's quarter hour falls in, as the instant of the
/// midnight that starts it.
///
/// SQLite applies the local zone's rules to each instant, so a day beside a
/// clock change is 23 or 25 hours long rather than shifted by an hour.
const LOCAL_DAY: &str = "unixepoch(date(at / 1000, 'unixepoch', 'localtime'), 'utc') * 1000";

/// The local hour a usage row's quarter hour falls in, as the instant it
/// starts.
///
/// The zone's offset at the instant says how far into its local hour it is,
/// so every span is an hour long. Grouping on the clock's reading would fold
/// the hour repeated when clocks go back into one span of two hours, and whole
/// hours of universal time would start half an hour off in zones such as
/// India's.
const LOCAL_HOUR: &str = "at - (at + (unixepoch(datetime(at / 1000, 'unixepoch', 'localtime')) \
                          - at / 1000) * 1000) % 3600000";

/// Where one session's history was read from.
pub struct Origin {
    /// The session, as the list shows it.
    pub session: Session,
    /// The unit it was last read from.
    pub unit: Unit,
    /// The agent's own id for it.
    pub native_id: String,
}

/// Usage within one span of local time, such as a day, split by agent.
struct Span {
    /// The instant it starts.
    start: i64,
    sessions: i64,
    tokens: Tokens,
    cost_usd: Option<f64>,
    by_agent: Vec<AgentDay>,
}

/// The index database.
pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open the index at `path`, creating or rebuilding it as needed.
    pub fn open(path: &Path) -> Result<Store> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            // WAL keeps reads from blocking the scanner's writes, and NORMAL
            // is the right durability for a cache that can be rebuilt.
            // Foreign keys are off by default in SQLite, which would make the
            // cascade declared in the schema silently do nothing.
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA foreign_keys = ON;
             PRAGMA mmap_size = 268435456;",
        )?;

        // Costs are estimated as the index is built, so new prices rebuild it
        // just as a new shape does.
        let version = format!("{SCHEMA}.{:x}", crate::price::version());
        // No table, no row, or a value of another version: all mean a rebuild.
        let found: Option<String> = connection
            .query_row("SELECT value FROM meta WHERE key = 'schema'", [], |row| {
                row.get(0)
            })
            .ok();

        if found.as_deref() != Some(version.as_str()) {
            // Whatever shape the cache had, it is rebuilt from nothing.
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
                params![version],
            )?;
        }
        Ok(Store { connection })
    }

    /// An in-memory index, for tests.
    #[cfg(test)]
    pub fn memory() -> Result<Store> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        connection.execute_batch(include_str!("schema.sql"))?;
        Ok(Store { connection })
    }

    // ------------------------------------------------------------ indexing --

    /// The file signatures the last scan recorded, by path.
    pub fn signatures(&self) -> Result<HashMap<String, (i64, i64)>> {
        let mut statement = self
            .connection
            .prepare("SELECT path, mtime, size FROM files")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Write what one unit holds, in a single transaction.
    ///
    /// A session can span several units — a Codex thread resumed into a new
    /// file is still one thread — so a unit replaces only its own usage, and
    /// the session's totals are summed from all of it. The session keeps the
    /// title of its earliest file, and the path, directory, branch and role of
    /// its latest, falling back to another file's where that one recorded
    /// none. It is spawned if any of its files says so. Files are read in
    /// parallel and finish in any order, so none of this may depend on which
    /// was written last.
    pub fn put(&mut self, unit: &Unit, summaries: &[Summary]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let path = unit.path.to_string_lossy().into_owned();
        // A file's name survives it being moved, as Codex does when archiving,
        // so a moved file replaces its usage rather than adding it again.
        let source = unit
            .path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
        {
            let mut insert = transaction.prepare_cached(
                "INSERT INTO sessions (
                    id, agent, native_id, title, cwd, branch, started_at, updated_at,
                    spawned, role, path)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(id) DO UPDATE SET
                    title = CASE WHEN excluded.started_at <= sessions.started_at
                                 THEN COALESCE(excluded.title, sessions.title)
                                 ELSE COALESCE(sessions.title, excluded.title) END,
                    started_at = MIN(sessions.started_at, excluded.started_at),
                    path = CASE WHEN excluded.updated_at >= sessions.updated_at
                                THEN excluded.path ELSE sessions.path END,
                    cwd = CASE WHEN excluded.updated_at >= sessions.updated_at
                               THEN COALESCE(excluded.cwd, sessions.cwd)
                               ELSE COALESCE(sessions.cwd, excluded.cwd) END,
                    branch = CASE WHEN excluded.updated_at >= sessions.updated_at
                                  THEN COALESCE(excluded.branch, sessions.branch)
                                  ELSE COALESCE(sessions.branch, excluded.branch) END,
                    role = CASE WHEN excluded.updated_at >= sessions.updated_at
                                THEN COALESCE(excluded.role, sessions.role)
                                ELSE COALESCE(sessions.role, excluded.role) END,
                    updated_at = MAX(sessions.updated_at, excluded.updated_at),
                    spawned = sessions.spawned OR excluded.spawned, present = 1",
            )?;
            let mut clear = transaction
                .prepare_cached("DELETE FROM usage WHERE session_id = ?1 AND source = ?2")?;
            let mut count = transaction.prepare_cached(
                "INSERT INTO usage (
                    session_id, source, at, provider, model, agent, input, output,
                    cache_read, cache_write, reasoning, total, cost_usd)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            )?;
            let mut total = transaction.prepare_cached(&format!(
                "UPDATE sessions SET
                    input = used.input, output = used.output,
                    cache_read = used.cache_read, cache_write = used.cache_write,
                    reasoning = used.reasoning, total_tokens = used.total,
                    cost_usd = used.cost_usd,
                    models = {models}
                 FROM (SELECT COALESCE(SUM(input), 0) AS input,
                              COALESCE(SUM(output), 0) AS output,
                              COALESCE(SUM(cache_read), 0) AS cache_read,
                              COALESCE(SUM(cache_write), 0) AS cache_write,
                              COALESCE(SUM(reasoning), 0) AS reasoning,
                              COALESCE(SUM(total), 0) AS total,
                              SUM(cost_usd) AS cost_usd
                       FROM usage WHERE session_id = ?1) AS used
                 WHERE sessions.id = ?1",
                models = shares("usage.session_id = ?1"),
            ))?;

            for Summary { session, usage } in summaries {
                insert.execute(params![
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
                    count.execute(params![
                        session.id,
                        source,
                        used.at,
                        used.provider,
                        used.model,
                        session.agent,
                        used.tokens.input,
                        used.tokens.output,
                        used.tokens.cache_read,
                        used.tokens.cache_write,
                        used.tokens.reasoning,
                        used.tokens.total,
                        used.cost_usd,
                    ])?;
                }
                total.execute(params![session.id])?;
            }

            transaction
                .prepare_cached(
                    "INSERT INTO files (path, mtime, size) VALUES (?1,?2,?3)
                     ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
                )?
                .execute(params![path, unit.mtime, unit.size])?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Keep a subscription's accounts, replacing what was kept for it before.
    ///
    /// Only accounts whose limits have been read are kept: one never read has
    /// nothing to show on the next launch.
    pub fn put_accounts(&mut self, provider: Provider, accounts: &[Account]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM accounts WHERE provider = ?1",
            params![provider.key()],
        )?;
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
    /// still history, and losing it silently would be worse than showing it
    /// with a note.
    pub fn retire(&mut self, missing: &[String]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        {
            let mut forget = transaction.prepare_cached("DELETE FROM files WHERE path = ?1")?;
            let mut absent =
                transaction.prepare_cached("UPDATE sessions SET present = 0 WHERE path = ?1")?;
            for path in missing {
                forget.execute(params![path])?;
                absent.execute(params![path])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Store the counts learned by reading a conversation in full.
    pub fn put_counts(&mut self, id: &str, messages: i64, tools: i64) -> Result<()> {
        self.connection.execute(
            "UPDATE sessions SET messages = ?2, tools = ?3 WHERE id = ?1",
            params![id, messages, tools],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------- reading --

    /// One page of the session list, with the totals of the whole match.
    ///
    /// Narrowed to a period, the list holds the sessions that used tokens in
    /// it, and each session's tokens, cost and models are only what it used
    /// there: the list is ordered and totalled by those, as the overview and
    /// its rankings count the same period. Otherwise they are the session's
    /// whole usage, kept on its row.
    pub fn list(&self, filter: &Filter) -> Result<SessionPage> {
        let (where_clause, mut bindings) = predicate(filter);
        let (source, models) = if filter.since.is_none() && filter.until.is_none() {
            ("sessions".to_owned(), "models".to_owned())
        } else {
            // Bounds rather than nulls for an open end, so the range reaches
            // the usage index and a short period reads only its own usage.
            bindings.push(Box::new(filter.since.unwrap_or(i64::MIN)));
            bindings.push(Box::new(filter.until.unwrap_or(i64::MAX)));
            let window = format!(
                "usage.at >= ?{} AND usage.at <= ?{}",
                bindings.len() - 1,
                bindings.len()
            );
            let source = format!(
                "(SELECT sessions.id, sessions.agent, sessions.native_id, sessions.title,
                         sessions.cwd, sessions.branch, sessions.started_at, sessions.updated_at,
                         sessions.spawned, sessions.role, used.input, used.output,
                         used.cache_read, used.cache_write, used.reasoning,
                         used.total AS total_tokens, used.cost_usd, sessions.messages,
                         sessions.tools, sessions.present
                  FROM sessions
                  JOIN (SELECT session_id, SUM(input) AS input, SUM(output) AS output,
                               SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                               SUM(reasoning) AS reasoning, SUM(total) AS total,
                               SUM(cost_usd) AS cost_usd
                        FROM usage WHERE {window}
                        GROUP BY session_id) AS used
                    ON used.session_id = sessions.id)"
            );
            let models = shares(&format!("usage.session_id = page.id AND {window}"));
            (source, models)
        };
        let order = format!(
            "{} {}",
            filter.sort.key.column(),
            if filter.sort.descending {
                "DESC"
            } else {
                "ASC"
            }
        );
        let limit = filter.limit.clamp(1, MAX_PAGE);
        let offset = filter.offset.max(0);

        // The page is chosen before its models are read, so a period sums the
        // models of the rows returned rather than of every match.
        let sql = format!(
            "SELECT id, agent, native_id, title, cwd, branch, started_at, updated_at,
                    spawned, role, {models}, input, output, cache_read, cache_write,
                    reasoning, total_tokens, cost_usd, messages, tools, present
             FROM (SELECT * FROM {source} AS listed WHERE {where_clause}
                   ORDER BY {order}, id LIMIT {limit} OFFSET {offset}) AS page
             ORDER BY {order}, id"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows =
            statement.query_map(rusqlite::params_from_iter(bindings.iter()), read_session)?;
        let sessions = rows.collect::<rusqlite::Result<Vec<Session>>>()?;

        let totals = format!(
            "SELECT COUNT(*), COALESCE(SUM(input),0), COALESCE(SUM(output),0),
                    COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
                    COALESCE(SUM(reasoning),0), COALESCE(SUM(total_tokens),0),
                    SUM(cost_usd)
             FROM {source} AS listed WHERE {where_clause}"
        );
        let (total, tokens, cost_usd) = self.connection.query_row(
            &totals,
            rusqlite::params_from_iter(bindings.iter()),
            |row| Ok((row.get::<_, i64>(0)?, read_tokens(row, 1)?, row.get(7)?)),
        )?;

        Ok(SessionPage {
            sessions,
            total,
            tokens,
            cost_usd,
        })
    }

    /// One session by id.
    pub fn get(&self, id: &str) -> Result<Option<Session>> {
        Ok(self
            .connection
            .query_row(
                "SELECT id, agent, native_id, title, cwd, branch, started_at, updated_at,
                        spawned, role, models, input, output, cache_read, cache_write,
                        reasoning, total_tokens, cost_usd, messages, tools, present
                 FROM sessions WHERE id = ?1",
                params![id],
                read_session,
            )
            .optional()?)
    }

    /// Where a session's history lives, for reading its conversation.
    pub fn locate(&self, id: &str) -> Result<Option<(Unit, String)>> {
        Ok(self
            .connection
            .query_row(
                "SELECT agent, native_id, path FROM sessions WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, String>(2)?)),
            )
            .optional()?
            .map(|(agent, native_id, path)| {
                let path = PathBuf::from(path);
                let (mtime, size) = crate::source::stat(&path).unwrap_or((0, 0));
                let unit = Unit {
                    agent,
                    path,
                    mtime,
                    size,
                };
                (unit, native_id)
            }))
    }

    /// Every session a filter matches, most recently active first, with where
    /// its history was read from. The filter's search, order and window do not
    /// apply: this is every match, for looking through each one's history.
    pub fn origins(&self, filter: &Filter) -> Result<Vec<Origin>> {
        let mut filter = Filter {
            search: None,
            sort: Sort {
                key: SortKey::Updated,
                descending: true,
            },
            offset: 0,
            limit: MAX_PAGE,
            ..filter.clone()
        };
        let mut sessions = Vec::new();
        loop {
            let page = self.list(&filter)?;
            let read = page.sessions.len() as i64;
            sessions.extend(page.sessions);
            filter.offset += read;
            if read < MAX_PAGE || filter.offset >= page.total {
                break;
            }
        }

        let mut origins = Vec::with_capacity(sessions.len());
        for session in sessions {
            if let Some((unit, native_id)) = self.locate(&session.id)? {
                origins.push(Origin {
                    session,
                    unit,
                    native_id,
                });
            }
        }
        Ok(origins)
    }

    /// Models ranked by the usage recorded within a period.
    pub fn models(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<ModelUsage>> {
        let mut statement = self.connection.prepare(
            "SELECT model,
                    GROUP_CONCAT(DISTINCT agent),
                    COUNT(DISTINCT session_id),
                    SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
                    SUM(reasoning), SUM(total), SUM(cost_usd)
             FROM usage
             WHERE model <> ''
               AND at >= COALESCE(?1, at)
               AND at <= COALESCE(?2, at)
             GROUP BY model ORDER BY SUM(total) DESC",
        )?;
        let rows = statement.query_map(params![since, until], |row| {
            let agents: String = row.get(1)?;
            Ok(ModelUsage {
                model: row.get(0)?,
                agents: agents.split(',').filter_map(Agent::from_key).collect(),
                sessions: row.get(2)?,
                tokens: read_tokens(row, 3)?,
                cost_usd: row.get(9)?,
                daily: Vec::new(),
            })
        })?;
        let mut models: Vec<ModelUsage> = rows.collect::<rusqlite::Result<_>>()?;

        let mut days = self.connection.prepare(&format!(
            "SELECT model, {LOCAL_DAY} AS day, SUM(total), SUM(cost_usd)
             FROM usage
             WHERE model <> ''
               AND at >= COALESCE(?1, at)
               AND at <= COALESCE(?2, at)
             GROUP BY model, day ORDER BY day"
        ))?;
        let mut rows = days.query(params![since, until])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(0)?;
            if let Some(model) = models.iter_mut().find(|model| model.model == name) {
                model.daily.push(ModelDay {
                    day: row.get(1)?,
                    tokens: row.get(2)?,
                    cost_usd: row.get(3)?,
                });
            }
        }
        Ok(models)
    }

    /// Projects, by the directory their sessions worked in, ranked by the usage
    /// recorded within a period. A session that recorded no directory belongs
    /// to none.
    pub fn projects(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<ProjectUsage>> {
        let mut statement = self.connection.prepare(
            "SELECT sessions.cwd, COUNT(DISTINCT usage.session_id),
                    SUM(usage.input), SUM(usage.output), SUM(usage.cache_read),
                    SUM(usage.cache_write), SUM(usage.reasoning), SUM(usage.total),
                    SUM(usage.cost_usd)
             FROM usage JOIN sessions ON sessions.id = usage.session_id
             WHERE sessions.cwd IS NOT NULL
               AND usage.at >= COALESCE(?1, usage.at)
               AND usage.at <= COALESCE(?2, usage.at)
             GROUP BY sessions.cwd ORDER BY SUM(usage.total) DESC",
        )?;
        let rows = statement.query_map(params![since, until], |row| {
            Ok(ProjectUsage {
                project: row.get(0)?,
                sessions: row.get(1)?,
                tokens: read_tokens(row, 2)?,
                cost_usd: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Totals for the overview, bucketed into local days.
    ///
    /// Sessions are those that used tokens in the period, and tokens and cost
    /// what they used within it. Days are this machine's, which is also the
    /// reader's:
    /// SQLite applies the local zone's rules to each instant, so a day beside a
    /// clock change is 23 or 25 hours long rather than shifted by an hour.
    pub fn overview(&self, since: Option<i64>, until: Option<i64>) -> Result<Overview> {
        let mut totals = self.connection.prepare(
            "SELECT agent, COUNT(DISTINCT session_id),
                    SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
                    SUM(reasoning), SUM(total), SUM(cost_usd)
             FROM usage
             WHERE at >= COALESCE(?1, at) AND at <= COALESCE(?2, at)
             GROUP BY agent ORDER BY SUM(total) DESC",
        )?;
        let by_agent: Vec<AgentTotals> = totals
            .query_map(params![since, until], |row| {
                Ok(AgentTotals {
                    agent: row.get(0)?,
                    sessions: row.get(1)?,
                    tokens: read_tokens(row, 2)?,
                    cost_usd: row.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let daily = self
            .spans(LOCAL_DAY, since, until)?
            .into_iter()
            .map(|span| DayTotals {
                day: span.start,
                sessions: span.sessions,
                tokens: span.tokens,
                cost_usd: span.cost_usd,
                by_agent: span.by_agent,
            })
            .collect();

        let mut tokens = Tokens::default();
        let mut cost_usd = None;
        let mut sessions = 0;
        for agent in &by_agent {
            tokens.add(agent.tokens);
            if let Some(cost) = agent.cost_usd {
                *cost_usd.get_or_insert(0.0) += cost;
            }
            sessions += agent.sessions;
        }

        Ok(Overview {
            sessions,
            tokens,
            cost_usd,
            by_agent,
            daily,
        })
    }

    /// Totals for each local hour of a period that had any usage, oldest
    /// first, for drawing a day by the hour.
    ///
    /// Sessions are those that used tokens in the hour, and tokens and cost
    /// what was used within it. Hours are this machine's, as days are.
    pub fn hours(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<HourTotals>> {
        Ok(self
            .spans(LOCAL_HOUR, since, until)?
            .into_iter()
            .map(|span| HourTotals {
                hour: span.start,
                sessions: span.sessions,
                tokens: span.tokens,
                cost_usd: span.cost_usd,
                by_agent: span.by_agent,
            })
            .collect())
    }

    /// Usage within a period in spans of local time, oldest first, each split
    /// by agent. `start` is [`LOCAL_DAY`] or [`LOCAL_HOUR`], the SQL placing a
    /// usage row in its span; nothing else reaches the statement's text.
    fn spans(&self, start: &str, since: Option<i64>, until: Option<i64>) -> Result<Vec<Span>> {
        // A row for each agent in each span, folded into spans that keep each
        // agent's share.
        let mut statement = self.connection.prepare(&format!(
            "SELECT {start} AS span, agent, COUNT(DISTINCT session_id),
                    SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
                    SUM(reasoning), SUM(total), SUM(cost_usd)
             FROM usage
             WHERE at >= COALESCE(?1, at) AND at <= COALESCE(?2, at)
             GROUP BY span, agent ORDER BY span, agent"
        ))?;
        let mut spans: Vec<Span> = Vec::new();
        let mut rows = statement.query(params![since, until])?;
        while let Some(row) = rows.next()? {
            let start = row.get(0)?;
            let tokens = read_tokens(row, 3)?;
            let cost_usd: Option<f64> = row.get(9)?;
            if spans.last().is_none_or(|last| last.start != start) {
                spans.push(Span {
                    start,
                    sessions: 0,
                    tokens: Tokens::default(),
                    cost_usd: None,
                    by_agent: Vec::new(),
                });
            }
            let span = spans.last_mut().expect("the span was just added");
            // A session belongs to one agent, so the agents' counts add up.
            span.sessions += row.get::<_, i64>(2)?;
            span.tokens.add(tokens);
            if let Some(cost) = cost_usd {
                *span.cost_usd.get_or_insert(0.0) += cost;
            }
            span.by_agent.push(AgentDay {
                agent: row.get(1)?,
                tokens: tokens.total,
                cost_usd,
            });
        }
        Ok(spans)
    }

    /// Every subscription's last successfully read limits.
    pub fn accounts(&self) -> Result<Vec<Account>> {
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
    pub fn last_used(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self.connection.prepare(
            "SELECT provider, MAX(at) + ?1 FROM usage WHERE provider <> '' GROUP BY provider",
        )?;
        let rows = statement.query_map([crate::source::QUARTER_HOUR], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// How many sessions the index holds.
    pub fn count(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?)
    }
}

/// The `WHERE` clause and bindings a filter resolves to, over the list's rows
/// as `listed`. A period is not among them: [`Store::list`] narrows to one by
/// reading only the usage inside it.
///
/// Values are bound rather than interpolated; only the sort column and the
/// page bounds reach the SQL text, and both come from closed sets.
fn predicate(filter: &Filter) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses = vec!["1 = 1".to_owned()];
    let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if !filter.include_spawned {
        clauses.push("spawned = 0".to_owned());
    }
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        bindings.push(Box::new(format!("%{search}%")));
        let placeholder = bindings.len();
        clauses.push(format!(
            "(title LIKE ?{placeholder}
              OR cwd LIKE ?{placeholder}
              OR EXISTS (SELECT 1 FROM usage
                         WHERE usage.session_id = listed.id
                           AND usage.model LIKE ?{placeholder}))"
        ));
    }
    if !filter.agents.is_empty() {
        let names: Vec<String> = filter
            .agents
            .iter()
            .map(|agent| format!("'{}'", agent.key()))
            .collect();
        // Agent keys are a closed set of identifiers, never caller text.
        clauses.push(format!("agent IN ({})", names.join(",")));
    }
    if let Some(project) = &filter.project {
        bindings.push(Box::new(project.clone()));
        clauses.push(format!("cwd = ?{}", bindings.len()));
    }
    if let Some(model) = &filter.model {
        bindings.push(Box::new(model.clone()));
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM usage
                     WHERE usage.session_id = listed.id AND usage.model = ?{})",
            bindings.len()
        ));
    }
    (clauses.join(" AND "), bindings)
}

/// A scalar subquery for usage by model, largest first, as the JSON a
/// session's `models` column holds and [`ModelSlice`] reads. `usage` is the
/// condition choosing the usage rows, such as one session's.
///
/// Usage recorded under no model counts toward a session but is no model's,
/// so it has no share.
fn shares(usage: &str) -> String {
    format!(
        "(SELECT json_group_array(json_object(
                     'model', model,
                     'tokens', json_object(
                         'input', input, 'output', output,
                         'cacheRead', cache_read, 'cacheWrite', cache_write,
                         'reasoning', reasoning, 'total', total),
                     'costUsd', cost_usd))
          FROM (SELECT model, SUM(input) AS input, SUM(output) AS output,
                       SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                       SUM(reasoning) AS reasoning, SUM(total) AS total,
                       SUM(cost_usd) AS cost_usd
                FROM usage WHERE {usage} AND usage.model <> ''
                GROUP BY model ORDER BY SUM(total) DESC))"
    )
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

/// Build a session from one row of the sessions table.
fn read_session(row: &rusqlite::Row) -> rusqlite::Result<Session> {
    let models: String = row.get(10)?;
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
        models: serde_json::from_str::<Vec<ModelSlice>>(&models).unwrap_or_default(),
        tokens: read_tokens(row, 11)?,
        cost_usd: row.get(17)?,
        messages: row.get(18)?,
        tools: row.get(19)?,
        present: row.get(20)?,
    })
}

/// Read the six token columns starting at `first`, in the order `Tokens`
/// declares them: input, output, cache read, cache write, reasoning, total.
fn read_tokens(row: &rusqlite::Row, first: usize) -> rusqlite::Result<Tokens> {
    Ok(Tokens {
        input: row.get(first)?,
        output: row.get(first + 1)?,
        cache_read: row.get(first + 2)?,
        cache_write: row.get(first + 3)?,
        reasoning: row.get(first + 4)?,
        total: row.get(first + 5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Sort, SortKey};
    use crate::source::Usage;

    const DAY: i64 = 86_400_000;

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

    fn filled() -> Store {
        let mut store = Store::memory().expect("opens");
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

    fn page(store: &Store, filter: Filter) -> SessionPage {
        store.list(&filter).expect("lists")
    }

    #[test]
    fn the_list_hides_spawned_runs_unless_asked() {
        let store = filled();
        let default = page(
            &store,
            Filter {
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(default.total, 3);
        assert!(default.sessions.iter().all(|session| !session.spawned));

        let all = page(
            &store,
            Filter {
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(all.total, 4);
    }

    #[test]
    fn a_list_narrows_to_one_project_or_one_model() {
        let mut store = filled();
        let mut elsewhere = summary("five", Agent::Codex, 5_000, 500, false);
        elsewhere.session.cwd = Some("/w/other".into());
        elsewhere.usage[0].model = "model-b".into();
        store.put(&unit("/c.jsonl"), &[elsewhere]).expect("writes");

        let in_project = |project: &str| {
            let filter = Filter {
                project: Some(project.into()),
                limit: 50,
                ..Filter::default()
            };
            page(&store, filter).total
        };
        assert_eq!(in_project("/w/proj"), 3);
        assert_eq!(in_project("/w/other"), 1);
        assert_eq!(in_project("/w"), 0, "a project is matched whole");

        let using = |model: &str| {
            let filter = Filter {
                model: Some(model.into()),
                limit: 50,
                ..Filter::default()
            };
            page(&store, filter).total
        };
        assert_eq!(using("model-a"), 3);
        assert_eq!(using("model-b"), 1);
        assert_eq!(using("model"), 0, "a model is matched whole");
    }

    #[test]
    fn each_model_carries_its_usage_by_day() {
        let store = filled();
        let models = store.models(None, None).expect("ranks");
        let daily: i64 = models[0].daily.iter().map(|day| day.tokens).sum();
        assert_eq!(
            daily, models[0].tokens.total,
            "every day adds up to the model"
        );
    }

    #[test]
    fn totals_cover_the_whole_match_not_the_page() {
        let store = filled();
        let first = page(
            &store,
            Filter {
                include_spawned: true,
                limit: 1,
                ..Filter::default()
            },
        );
        assert_eq!(first.sessions.len(), 1, "one row was asked for");
        assert_eq!(first.total, 4, "but the count covers every match");
        // 300 + 100 + 200 + 400, computed by hand from the fixtures.
        assert_eq!(first.tokens.total, 1_000);
        assert_eq!(first.cost_usd, Some(6.0));
    }

    #[test]
    fn every_sort_key_orders_and_reverses() {
        let store = filled();
        for key in [
            SortKey::Updated,
            SortKey::Started,
            SortKey::Tokens,
            SortKey::Cost,
            SortKey::Title,
        ] {
            for descending in [true, false] {
                let result = page(
                    &store,
                    Filter {
                        include_spawned: true,
                        limit: 50,
                        sort: Sort { key, descending },
                        ..Filter::default()
                    },
                );
                assert_eq!(result.sessions.len(), 4, "{key:?} returned every row");
            }
        }

        let newest = page(
            &store,
            Filter {
                include_spawned: true,
                limit: 50,
                sort: Sort {
                    key: SortKey::Updated,
                    descending: true,
                },
                ..Filter::default()
            },
        );
        let order: Vec<_> = newest
            .sessions
            .iter()
            .map(|session| session.native_id.as_str())
            .collect();
        assert_eq!(order, ["four", "one", "three", "two"]);
    }

    #[test]
    fn paging_walks_the_whole_result_without_repeating() {
        let store = filled();
        let mut seen = Vec::new();
        for offset in 0..4 {
            let result = page(
                &store,
                Filter {
                    include_spawned: true,
                    limit: 1,
                    offset,
                    ..Filter::default()
                },
            );
            seen.push(result.sessions[0].id.clone());
        }
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 4, "every row appeared exactly once");
    }

    #[test]
    fn search_matches_title_directory_and_model() {
        let store = filled();
        let by_title = page(
            &store,
            Filter {
                search: Some("Session one".into()),
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(by_title.total, 1);

        let by_directory = page(
            &store,
            Filter {
                search: Some("w/proj".into()),
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(by_directory.total, 4);

        let by_model = page(
            &store,
            Filter {
                search: Some("model-a".into()),
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(by_model.total, 4);

        // The model shares are also kept as JSON on the row, so a search that
        // reached that JSON would match its field names in every session.
        for structural in ["tokens", "costUsd", "cacheRead", "model\":"] {
            let spurious = page(
                &store,
                Filter {
                    search: Some(structural.into()),
                    include_spawned: true,
                    limit: 50,
                    ..Filter::default()
                },
            );
            assert_eq!(spurious.total, 0, "{structural} must not match every row");
        }

        let nothing = page(
            &store,
            Filter {
                search: Some("no such thing".into()),
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(nothing.total, 0);
    }

    #[test]
    fn a_search_term_with_sql_in_it_is_bound_not_interpolated() {
        let store = filled();
        let hostile = page(
            &store,
            Filter {
                search: Some("'; DROP TABLE sessions; --".into()),
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(hostile.total, 0);
        // The table must still be there.
        assert_eq!(store.count().expect("counts"), 4);
    }

    #[test]
    fn filtering_by_agent_and_period_narrows_the_match() {
        let store = filled();
        let codex = page(
            &store,
            Filter {
                agents: vec![Agent::Codex],
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(codex.total, 2);

        let recent = page(
            &store,
            Filter {
                since: Some(2_000),
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(recent.total, 3);

        let window = page(
            &store,
            Filter {
                since: Some(2_000),
                until: Some(3_000),
                include_spawned: true,
                limit: 50,
                ..Filter::default()
            },
        );
        assert_eq!(window.total, 2);
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
        let mut store = Store::memory().expect("opens");
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
            let mut store = Store::memory().expect("opens");
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
        // A rescan re-summarizes the unit, which knows nothing about counts.
        store
            .put(
                &unit("/a.jsonl"),
                &[summary("one", Agent::Codex, 3_000, 300, false)],
            )
            .expect("writes");

        let found = store.get("codex:one").expect("reads").expect("exists");
        assert_eq!(found.messages, Some(42), "counts must not be cleared");
        assert_eq!(found.tools, Some(17));
    }

    #[test]
    fn retiring_a_file_keeps_its_sessions_but_marks_them_absent() {
        let mut store = filled();
        store.retire(&["/a.jsonl".into()]).expect("retires");

        let found = store.get("codex:one").expect("reads").expect("still there");
        assert!(!found.present, "the history is kept, flagged as gone");
        assert!(
            !store.signatures().expect("reads").contains_key("/a.jsonl"),
            "but the file is no longer tracked, so it can be re-found"
        );
    }

    #[test]
    fn signatures_drive_incremental_rescans() {
        let store = filled();
        let signatures = store.signatures().expect("reads");
        assert_eq!(signatures.get("/a.jsonl"), Some(&(10, 20)));
        assert_eq!(signatures.len(), 2);
    }

    #[test]
    fn models_rank_by_recorded_usage() {
        let mut store = Store::memory().expect("opens");
        let mut multi = summary("m1", Agent::ClaudeCode, 5_000, 300, false);
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
        ];
        store.put(&unit("/m.jsonl"), &[multi]).expect("writes");

        let ranked = store.models(None, None).expect("ranks");
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].model, "opus");
        assert_eq!(ranked[0].tokens.total, 250);
        assert_eq!(ranked[0].cost_usd, Some(2.0));
        assert_eq!(ranked[0].sessions, 1);
        assert_eq!(ranked[0].agents, [Agent::ClaudeCode]);
        assert_eq!(ranked[1].model, "haiku");
        assert_eq!(ranked[1].cost_usd, None, "unpriced is not free");

        // The session's own shares come largest first too.
        let session = store.get("claude_code:m1").expect("reads").expect("exists");
        let shares: Vec<_> = session
            .models
            .iter()
            .map(|slice| (slice.model.as_str(), slice.cost_usd))
            .collect();
        assert_eq!(shares, [("opus", Some(2.0)), ("haiku", None)]);
        assert_eq!(session.cost_usd, Some(2.0));
    }

    #[test]
    fn a_models_period_excludes_work_outside_it() {
        let store = filled();
        assert_eq!(
            store.models(Some(3_500), None).expect("ranks")[0].sessions,
            1
        );
        assert!(store.models(Some(99_000), None).expect("ranks").is_empty());
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

        // By hand from the fixtures: 300 + 100 + 200 + 400 in /w/proj and 500
        // in /w/other, each usage priced at 1.5. The 600 with no directory is
        // in neither.
        let all = store.projects(None, None).expect("ranks");
        let ranked: Vec<_> = all
            .iter()
            .map(|project| {
                (
                    project.project.as_str(),
                    project.sessions,
                    project.tokens.total,
                    project.cost_usd,
                )
            })
            .collect();
        assert_eq!(
            ranked,
            [
                ("/w/proj", 4, 1_000, Some(6.0)),
                ("/w/other", 1, 500, Some(1.5))
            ]
        );

        // From 3,500 on, only four's 400 and five's 500 were used.
        let recent = store.projects(Some(3_500), None).expect("ranks");
        let ranked: Vec<_> = recent
            .iter()
            .map(|project| (project.project.as_str(), project.tokens.total))
            .collect();
        assert_eq!(ranked, [("/w/other", 500), ("/w/proj", 400)]);
    }

    #[test]
    fn a_period_counts_only_the_usage_inside_it() {
        let mut store = Store::memory().expect("opens");
        // A session that used 100 tokens on its first day and 40 on its second.
        let mut spanning = summary("span", Agent::Codex, DAY + DAY / 2, 140, false);
        spanning.usage = vec![usage(DAY / 2, 100), usage(DAY + DAY / 2, 40)];
        store.put(&unit("/s.jsonl"), &[spanning]).expect("writes");

        let second = store.overview(Some(DAY), None).expect("totals");
        assert_eq!(second.tokens.total, 40, "the first day's usage is outside");
        assert_eq!(second.sessions, 1, "but the session used tokens in it");
        // The list narrows the same way, by when tokens were used, and counts
        // the same usage.
        let listed = |since, until| {
            let filter = Filter {
                since,
                until,
                limit: 50,
                ..Filter::default()
            };
            store.list(&filter).expect("lists")
        };
        let later = listed(Some(DAY), None);
        assert_eq!(later.total, 1);
        assert_eq!((later.tokens.total, later.cost_usd), (40, Some(1.5)));
        let row = &later.sessions[0];
        assert_eq!((row.tokens.total, row.cost_usd), (40, Some(1.5)));
        assert_eq!(row.models[0].tokens.total, 40);
        let first = listed(None, Some(DAY - 1));
        assert_eq!(first.sessions[0].tokens.total, 100, "a period can end, too");
        assert_eq!(
            listed(Some(2 * DAY), None).total,
            0,
            "nothing was used after"
        );
        assert_eq!(listed(None, Some(DAY / 2 - 1)).total, 0, "nor before");
        assert_eq!(second.daily.len(), 1);
        let models = store.models(Some(DAY), None).expect("ranks");
        assert_eq!(models[0].tokens.total, 40);

        let all = store.overview(None, None).expect("totals");
        let days: Vec<_> = all.daily.iter().map(|day| day.tokens.total).collect();
        assert_eq!(days, [100, 40]);
        // The session itself is still the whole of it.
        let whole = store.get("codex:span").expect("reads").expect("exists");
        assert_eq!((whole.tokens.total, whole.cost_usd), (140, Some(3.0)));
    }

    #[test]
    fn a_period_orders_and_totals_the_list_by_what_was_used_in_it() {
        let mut store = Store::memory().expect("opens");
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

        let list = |filter: Filter| {
            store
                .list(&Filter {
                    limit: 50,
                    ..filter
                })
                .expect("lists")
        };
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
        let rest = list(Filter {
            since: Some(DAY),
            sort: largest(SortKey::Tokens),
            offset: 1,
            ..Filter::default()
        });
        assert_eq!(ranked(&rest), [("busy".into(), 10)]);
        let narrowed = list(Filter {
            since: Some(DAY),
            model: Some("model-b".into()),
            search: Some("late".into()),
            ..Filter::default()
        });
        assert_eq!(narrowed.total, 1);
        assert_eq!(narrowed.sessions[0].native_id, "late");
    }

    #[test]
    fn the_overview_totals_agree_with_its_parts() {
        let store = filled();
        let overview = store.overview(None, None).expect("totals");
        assert_eq!(overview.sessions, 4);
        assert_eq!(overview.tokens.total, 1_000);
        assert_eq!(overview.cost_usd, Some(6.0));

        let summed: i64 = overview.by_agent.iter().map(|a| a.tokens.total).sum();
        assert_eq!(summed, overview.tokens.total);
        let daily: i64 = overview.daily.iter().map(|day| day.tokens.total).sum();
        assert_eq!(daily, overview.tokens.total, "all usage lands in a day");
        for day in &overview.daily {
            let shares: i64 = day.by_agent.iter().map(|share| share.tokens).sum();
            assert_eq!(shares, day.tokens.total, "a day's agents add up to it");
        }
    }

    #[test]
    fn days_break_at_local_midnight_even_beside_a_clock_change() {
        let mut store = Store::memory().expect("opens");
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
        let mut store = Store::memory().expect("opens");
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
        let recorded = clock.usage.len() as i64;
        store.put(&unit("/c.jsonl"), &[clock]).expect("writes");

        let hours = store.hours(None, None).expect("totals");
        let counted: i64 = hours.iter().map(|hour| hour.tokens.total).sum();
        assert_eq!(counted, recorded, "every quarter hour lands in an hour");
        let daily = store.overview(None, None).expect("totals").daily;
        assert_eq!(
            daily.iter().map(|day| day.tokens.total).sum::<i64>(),
            counted
        );

        // The ends of each run may start or stop part-way into a local hour.
        for pair in hours.windows(2) {
            let (before, after) = (&pair[0], &pair[1]);
            let within = |at: i64| {
                (spring.0 * 1_000 + 3_600_000..spring.1 * 1_000 - 3_600_000).contains(&at)
                    || (autumn.0 * 1_000 + 3_600_000..autumn.1 * 1_000 - 3_600_000).contains(&at)
            };
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
        let mut store = Store::memory().expect("opens");
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

        let mut kept: Vec<String> = store
            .accounts()
            .expect("reads")
            .into_iter()
            .map(|account| account.id)
            .collect();
        kept.sort();
        assert_eq!(kept, ["codex:a", "grok:c"]);
    }

    #[test]
    fn a_page_cannot_be_asked_for_more_than_the_maximum() {
        let store = filled();
        let huge = page(
            &store,
            Filter {
                limit: 10_000,
                include_spawned: true,
                ..Filter::default()
            },
        );
        assert_eq!(huge.sessions.len(), 4, "bounded by what exists");

        // A zero or negative limit must still return a usable page rather than
        // an empty one or a SQL error.
        let zero = page(
            &store,
            Filter {
                limit: 0,
                include_spawned: true,
                ..Filter::default()
            },
        );
        assert_eq!(zero.sessions.len(), 1);
    }

    #[test]
    fn locating_a_session_names_its_file_and_native_id() {
        let store = filled();
        let (unit, native_id) = store.locate("codex:one").expect("reads").expect("exists");
        assert_eq!(unit.path, PathBuf::from("/a.jsonl"));
        assert_eq!(unit.agent, Agent::Codex);
        assert_eq!(native_id, "one");
        assert!(store.locate("codex:missing").expect("reads").is_none());
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
}
