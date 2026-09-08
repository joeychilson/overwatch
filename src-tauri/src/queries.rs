use crate::{
    data::*,
    error::{AppError, Result},
    index::Index,
};
use chrono::TimeZone;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScope {
    pub agent: Option<Agent>,
    pub project: Option<String>,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub offerings: Vec<String>,
}
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionSort {
    Title,
    Project,
    Tokens,
    Duration,
    Responses,
    #[default]
    UpdatedAt,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuery {
    pub scope: HistoryScope,
    pub search: String,
    pub search_models: Vec<String>,
    pub activity_after: Option<i64>,
    pub activity_before: Option<i64>,
    pub day: Option<String>,
    pub tool: Option<String>,
    pub model: Option<String>,
    pub failed_only: bool,
    pub usage_only: bool,
    pub offset: u32,
    pub limit: u32,
    pub sort: SessionSort,
    pub descending: bool,
}
impl Default for SessionQuery {
    fn default() -> Self {
        Self {
            scope: HistoryScope::default(),
            search: String::new(),
            search_models: vec![],
            activity_after: None,
            activity_before: None,
            day: None,
            tool: None,
            model: None,
            failed_only: false,
            usage_only: false,
            offset: 0,
            limit: 50,
            sort: SessionSort::UpdatedAt,
            descending: true,
        }
    }
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub tokens: Tokens,
    pub calls: u32,
    pub models: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<Session>,
    pub usage: HashMap<String, UsageSummary>,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionNavigation {
    pub previous: Option<String>,
    pub next: Option<String>,
    pub position: Option<u32>,
    pub total: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub sources: Vec<SourceStatus>,
    pub projects: Vec<(String, String)>,
    pub session_count: u32,
    pub scanning: bool,
    pub longest_session: Option<u64>,
    pub offerings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    #[serde(flatten)]
    pub stats: ToolStats,
    pub agents: Vec<Agent>,
}

// Canonical sessions are chosen among enabled sources BEFORE any user filters.
// Tie-breaking by source makes pagination stable even when copies have equal dates.
const CANONICAL:&str = "WITH enabled AS (SELECT value AS agent FROM json_each(?1)), canonical AS NOT MATERIALIZED (
 SELECT r.* FROM history_rows r JOIN enabled e ON e.agent=r.agent
 WHERE NOT EXISTS(SELECT 1 FROM history_rows newer JOIN enabled en ON en.agent=newer.agent
 WHERE newer.id=r.id AND (newer.updated>r.updated OR (newer.updated=r.updated AND newer.source<r.source))))";
const SCOPE: &str = "(json_extract(?2,'$.agent') IS NULL OR r.agent=json_extract(?2,'$.agent'))
 AND (json_extract(?2,'$.project') IS NULL OR r.cwd=json_extract(?2,'$.project'))";
const USAGE:&str = "(json_extract(?2,'$.start') IS NULL OR u.timestamp>=json_extract(?2,'$.start'))
 AND (json_extract(?2,'$.end') IS NULL OR u.timestamp<json_extract(?2,'$.end'))
 AND (json_array_length(json_extract(?2,'$.offerings'))=0 OR u.provider||'/'||u.model IN (SELECT value FROM json_each(?2,'$.offerings')))";

// SQLite's per-row localtime conversion is expensive on macOS. Cache calendar
// boundaries during each query, preserving local midnight and DST exactly.
fn prepare_calendar(db: &Connection) -> Result<()> {
    let cached = std::cell::RefCell::new(None::<(i64, i64, String)>);
    db.create_scalar_function(
        "history_day",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8,
        move |context| {
            let mut cached = cached.borrow_mut();
            let timestamp: i64 = context.get(0)?;
            if timestamp <= 0 {
                return Ok(None::<String>);
            }
            if let Some((start, end, day)) = &*cached
                && timestamp >= *start
                && timestamp < *end
            {
                return Ok(Some(day.clone()));
            }
            let Some(local) = chrono::Local.timestamp_millis_opt(timestamp).single() else {
                return Ok(None);
            };
            let date = local.date_naive();
            let day = date.format("%Y-%m-%d").to_string();
            let midnight = |date: chrono::NaiveDate| {
                date.and_hms_opt(0, 0, 0)
                    .and_then(|date| chrono::Local.from_local_datetime(&date).earliest())
                    .map(|date| date.timestamp_millis())
            };
            *cached = midnight(date)
                .zip(date.succ_opt().and_then(midnight))
                .filter(|(start, end)| timestamp >= *start && timestamp < *end)
                .map(|(start, end)| (start, end, day.clone()));
            Ok(Some(day))
        },
    )?;
    Ok(())
}
fn enabled(index: &Index) -> Result<String> {
    Ok(serde_json::to_string(
        &index
            .sources()?
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.agent)
            .collect::<Vec<_>>(),
    )?)
}
fn session_order(query: &SessionQuery) -> String {
    let order = match query.sort {
        SessionSort::Title => "title COLLATE NOCASE",
        SessionSort::Project => "project COLLATE NOCASE",
        SessionSort::Tokens => {
            if query.usage_only {
                "usage_tokens"
            } else {
                "tokens"
            }
        }
        SessionSort::Duration => "elapsed",
        SessionSort::Responses => "usage_calls",
        SessionSort::UpdatedAt => "updated",
    };
    format!(
        "{order} {} NULLS LAST,id,source",
        if query.descending { "DESC" } else { "ASC" }
    )
}
fn session_sql(query: &SessionQuery) -> String {
    let usage_tokens = if query.usage_only && matches!(query.sort, SessionSort::Tokens) {
        format!(
            "(SELECT COALESCE(SUM(u.input+u.output+u.cache_read+u.cache_write),0) FROM history_usage u WHERE u.source=r.source AND {USAGE})"
        )
    } else {
        "0".into()
    };
    let usage_calls = if matches!(query.sort, SessionSort::Responses) {
        format!("(SELECT COUNT(*) FROM history_usage u WHERE u.source=r.source AND {USAGE})")
    } else {
        "0".into()
    };
    format!("{CANONICAL}, filtered AS (SELECT r.*,
      {usage_tokens} AS usage_tokens,
      {usage_calls} AS usage_calls
      FROM canonical r WHERE {SCOPE}
      AND (?3='' OR instr(r.search,?3)>0 OR r.model IN (SELECT value FROM json_each(?4,'$.searchModels')))
      AND (json_extract(?4,'$.activityAfter') IS NULL OR r.updated>=json_extract(?4,'$.activityAfter'))
      AND (json_extract(?4,'$.activityBefore') IS NULL OR r.updated<json_extract(?4,'$.activityBefore'))
      AND (json_extract(?4,'$.day') IS NULL OR history_day(r.started)=json_extract(?4,'$.day')
        OR EXISTS(SELECT 1 FROM history_usage u WHERE u.source=r.source AND u.timestamp>0 AND history_day(u.timestamp)=json_extract(?4,'$.day')))
      AND (json_extract(?4,'$.tool') IS NULL OR EXISTS(SELECT 1 FROM history_tools t WHERE t.source=r.source AND t.name=json_extract(?4,'$.tool')))
      AND (NOT json_extract(?4,'$.failedOnly') OR EXISTS(SELECT 1 FROM history_tools t WHERE t.source=r.source AND t.failures>0 AND (json_extract(?4,'$.tool') IS NULL OR t.name=json_extract(?4,'$.tool'))))
      AND (json_extract(?4,'$.model') IS NULL OR EXISTS(SELECT 1 FROM history_usage u WHERE u.source=r.source AND u.model=json_extract(?4,'$.model')))
      AND (NOT json_extract(?4,'$.usageOnly') OR EXISTS(SELECT 1 FROM history_usage u WHERE u.source=r.source AND {USAGE})))")
}

pub fn sessions(index: &Index, query: &SessionQuery) -> Result<SessionPage> {
    let agents = enabled(index)?;
    let scope = serde_json::to_string(&query.scope)?;
    let raw = serde_json::to_string(query)?;
    let search = query.search.to_lowercase();
    let sql = session_sql(query);
    let db = index.db.lock()?;
    prepare_calendar(&db)?;
    let total: u32 = db.query_row(
        &format!("{sql} SELECT COUNT(*) FROM filtered"),
        params![agents, scope, search, raw],
        |row| row.get(0),
    )?;
    let limit = query.limit.clamp(1, 100);
    let offset = query.offset.min(total.saturating_sub(1) / limit * limit);
    let mut statement = db.prepare(&format!(
        "{sql} SELECT data,source FROM filtered ORDER BY {} LIMIT ?5 OFFSET ?6",
        session_order(query)
    ))?;
    let mut sessions = Vec::new();
    let mut usage = HashMap::new();
    for row in statement.query_map(params![agents, scope, search, raw, limit, offset], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (data, source) = row?;
        let session: Session = serde_json::from_str(&data)?;
        if query.usage_only {
            usage.insert(session.id.clone(), usage_summary(&db, &source, &scope)?);
        }
        sessions.push(session);
    }
    Ok(SessionPage {
        sessions,
        usage,
        total,
        offset,
        limit,
    })
}
fn usage_summary(db: &Connection, source: &str, scope: &str) -> Result<UsageSummary> {
    let mut statement=db.prepare_cached(&format!("SELECT u.model,SUM(u.input),SUM(u.output),SUM(u.cache_read),SUM(u.cache_write),SUM(u.reasoning),COUNT(*) FROM history_usage u WHERE source=?1 AND {USAGE} GROUP BY model"))?;
    let mut summary = UsageSummary::default();
    for row in statement.query_map(params![source, scope], |row| {
        Ok((
            row.get::<_, String>(0)?,
            tokens(row, 1)?,
            row.get::<_, u32>(6)?,
        ))
    })? {
        let (model, tokens, calls) = row?;
        summary.models.push(model);
        summary.tokens.add(tokens);
        summary.calls += calls;
    }
    Ok(summary)
}
pub fn navigation(index: &Index, query: &SessionQuery, id: &str) -> Result<SessionNavigation> {
    let agents = enabled(index)?;
    let db = index.db.lock()?;
    prepare_calendar(&db)?;
    let scope = serde_json::to_string(&query.scope)?;
    let raw = serde_json::to_string(query)?;
    let search = query.search.to_lowercase();
    let sql = format!(
        "{}, ordered AS (SELECT id,ROW_NUMBER() OVER(ORDER BY {})-1 AS position FROM filtered)",
        session_sql(query),
        session_order(query)
    );
    Ok(db.query_row(
        &format!(
            "{sql} SELECT
      (SELECT id FROM ordered WHERE position=(SELECT position-1 FROM ordered WHERE id=?5)),
      (SELECT id FROM ordered WHERE position=(SELECT position+1 FROM ordered WHERE id=?5)),
      (SELECT position FROM ordered WHERE id=?5),(SELECT COUNT(*) FROM filtered)"
        ),
        params![agents, scope, search, raw, id],
        |row| {
            Ok(SessionNavigation {
                previous: row.get(0)?,
                next: row.get(1)?,
                position: row.get(2)?,
                total: row.get(3)?,
            })
        },
    )?)
}
pub fn status(
    index: &Index,
    mut sources: Vec<SourceStatus>,
    scanning: bool,
) -> Result<HistoryStatus> {
    let agents = serde_json::to_string(
        &sources
            .iter()
            .filter(|s| s.source.enabled)
            .map(|s| s.source.agent)
            .collect::<Vec<_>>(),
    )?;
    let db = index.db.lock()?;
    for source in &mut sources {
        source.sessions = 0;
    }
    let mut session_count = 0;
    let mut longest_session = None;
    let mut counts = db.prepare(&format!(
        "{CANONICAL} SELECT agent,COUNT(*),MAX(elapsed) FROM canonical GROUP BY agent"
    ))?;
    for row in counts.query_map([&agents], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, Option<i64>>(2)?.map(|value| value as u64),
        ))
    })? {
        let (agent, count, longest) = row?;
        session_count += count;
        longest_session = longest_session.max(longest);
        if let Some(source) = sources
            .iter_mut()
            .find(|source| source.source.agent.id() == agent)
        {
            source.sessions = count;
        }
    }
    let projects=db.prepare(&format!("{CANONICAL} SELECT cwd,MIN(project) FROM canonical WHERE cwd<>'' GROUP BY cwd ORDER BY MIN(project) COLLATE NOCASE,cwd"))?.query_map([&agents],|row|Ok((row.get(0)?,row.get(1)?)))?.collect::<std::result::Result<_,_>>()?;
    let offerings=db.prepare(&format!("{CANONICAL} SELECT DISTINCT u.provider||'/'||u.model FROM history_usage u JOIN canonical r ON r.source=u.source ORDER BY 1"))?.query_map([&agents],|row|row.get(0))?.collect::<std::result::Result<_,_>>()?;
    Ok(HistoryStatus {
        sources,
        projects,
        session_count,
        scanning,
        longest_session,
        offerings,
    })
}
pub fn allowances(index: &Index) -> Result<Vec<QuotaSample>> {
    let agents = enabled(index)?;
    let db = index.db.lock()?;
    let mut query = db.prepare(&format!("{CANONICAL}, samples AS (
        SELECT l.data,json_extract(l.data,'$.agent') AS agent,json_extract(l.data,'$.bucket') AS bucket,
        json_extract(l.data,'$.accountKey') AS account,json_extract(l.data,'$.resetsAt') AS resets,
        json_extract(l.data,'$.timestamp') AS timestamp FROM history_limits l JOIN canonical r ON r.source=l.source),
        latest AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,bucket ORDER BY timestamp DESC,data) AS recent FROM samples),
        current_samples AS (SELECT s.*,ROW_NUMBER() OVER(PARTITION BY s.agent,s.bucket,s.timestamp/60000 ORDER BY s.timestamp DESC,s.data) AS minute_rank
        FROM samples s JOIN latest c ON c.recent=1 AND c.agent=s.agent AND c.bucket=s.bucket
        AND c.account IS s.account AND c.resets IS s.resets WHERE s.timestamp>=c.timestamp-21600000)
        SELECT data FROM current_samples WHERE minute_rank=1 ORDER BY timestamp"))?;
    let rows = query.query_map([&agents], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryTotals {
    pub tokens: Tokens,
    pub total: u64,
    pub calls: u32,
    pub cost: f64,
    pub recorded_cost: f64,
    pub estimated_cost: f64,
    pub priced_calls: u32,
    pub unpriced_calls: u32,
    pub unpriced: u64,
    pub undated_calls: u32,
    pub undated_tokens: u64,
}
impl QueryTotals {
    fn add(&mut self, tokens: Tokens, calls: u32, cost: Option<f64>, recorded: bool) {
        self.tokens.add(tokens);
        self.total += tokens.total();
        self.calls += calls;
        if let Some(cost) = cost {
            self.cost += cost;
            self.priced_calls += calls;
            if recorded {
                self.recorded_cost += cost;
            } else {
                self.estimated_cost += cost;
            }
        } else {
            self.unpriced_calls += calls;
            self.unpriced += tokens.total();
        }
    }
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChartModel {
    pub tokens: u64,
    pub cost: f64,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: String,
    pub totals: QueryTotals,
    pub agents: HashMap<Agent, u64>,
    pub agent_costs: HashMap<Agent, f64>,
    pub agent_priced_calls: HashMap<Agent, u32>,
    pub models: HashMap<String, ChartModel>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    pub model: String,
    pub provider: String,
    pub totals: QueryTotals,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub totals: QueryTotals,
    pub days: Vec<UsageDay>,
    pub models: Vec<UsageModel>,
    pub session_count: u32,
    pub project_count: u32,
    pub agent_count: u32,
}
fn tokens(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Tokens> {
    Ok(Tokens {
        input: unsigned(row, offset)?,
        output: unsigned(row, offset + 1)?,
        cache_read: unsigned(row, offset + 2)?,
        cache_write: unsigned(row, offset + 3)?,
        reasoning: unsigned(row, offset + 4)?,
    })
}
fn unsigned(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(offset)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(offset, value))
}
fn price_models(index: &Index) -> Result<HashMap<String, serde_json::Value>> {
    let payload = crate::catalog::stored(index, true);
    let providers: serde_json::Value = serde_json::from_str(&payload.json)?;
    let mut result = HashMap::new();
    for (provider, data) in providers
        .as_object()
        .ok_or_else(|| AppError::InvalidData("Invalid cached prices".into()))?
    {
        if let Some(models) = data["models"].as_object() {
            for (id, model) in models {
                result.insert(format!("{provider}/{id}"), model["cost"].clone());
            }
        }
    }
    Ok(result)
}
fn token_cost(tokens: Tokens, price: Option<&serde_json::Value>) -> Option<f64> {
    let price = price?;
    let mut cost = 0.0;
    for (count, field) in [
        (tokens.input, "input"),
        (tokens.output, "output"),
        (tokens.cache_read, "cache_read"),
        (tokens.cache_write, "cache_write"),
    ] {
        if count > 0 {
            cost += count as f64
                * price[field]
                    .as_f64()
                    .filter(|p| p.is_finite() && *p >= 0.0)?
                / 1_000_000.0;
        }
    }
    Some(cost)
}
pub fn usage(index: &Index, scope: &HistoryScope) -> Result<UsageReport> {
    let agents = enabled(index)?;
    let prices = price_models(index)?;
    let mut unambiguous: HashMap<&str, Option<&serde_json::Value>> = HashMap::new();
    for (key, price) in &prices {
        if let Some((_, id)) = key.split_once('/') {
            unambiguous
                .entry(id)
                .and_modify(|p| *p = None)
                .or_insert(Some(price));
        }
    }
    let raw = serde_json::to_string(scope)?;
    let db = index.db.lock()?;
    prepare_calendar(&db)?;
    let mut report = UsageReport::default();
    let mut days: BTreeMap<String, UsageDay> = BTreeMap::new();
    let mut models: BTreeMap<String, UsageModel> = BTreeMap::new();
    // Group by token-presence mask so unknown component rates never make priced
    // responses indistinguishable from unpriced responses after aggregation.
    let sql=format!("{CANONICAL} SELECT CASE WHEN u.timestamp>0 THEN history_day(u.timestamp) END,
      r.agent,u.provider,u.model,u.reported_cost IS NOT NULL,
      SUM(u.input),SUM(u.output),SUM(u.cache_read),SUM(u.cache_write),SUM(u.reasoning),SUM(u.reported_cost),COUNT(*)
      FROM history_usage u JOIN canonical r ON r.source=u.source WHERE {SCOPE}
      AND (json_array_length(json_extract(?2,'$.offerings'))=0 OR u.provider||'/'||u.model IN (SELECT value FROM json_each(?2,'$.offerings')))
      AND (u.timestamp<=0 OR {USAGE})
      GROUP BY 1,2,3,4,5,(u.input>0)+2*(u.output>0)+4*(u.cache_read>0)+8*(u.cache_write>0)");
    let mut statement = db.prepare(&sql)?;
    for row in statement.query_map(params![agents, raw], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, bool>(4)?,
            tokens(r, 5)?,
            r.get::<_, Option<f64>>(10)?,
            r.get::<_, u32>(11)?,
        ))
    })? {
        let (date, agent, provider, model, recorded, tokens, recorded_cost, calls) = row?;
        let agent: Agent = serde_json::from_value(serde_json::Value::String(agent))?;
        if date.is_none() {
            report.totals.undated_calls += calls;
            report.totals.undated_tokens += tokens.total();
            if scope.start.is_some() || scope.end.is_some() {
                continue;
            }
        }
        let key = format!("{provider}/{model}");
        let price = if provider.is_empty() {
            unambiguous.get(model.as_str()).copied().flatten()
        } else {
            prices.get(&key)
        };
        let cost = if recorded {
            recorded_cost
        } else {
            token_cost(tokens, price)
        };
        report.totals.add(tokens, calls, cost, recorded);
        let entry = models.entry(key.clone()).or_insert_with(|| UsageModel {
            model,
            provider,
            ..UsageModel::default()
        });
        entry.totals.add(tokens, calls, cost, recorded);
        if let Some(date) = date {
            let day = days.entry(date.clone()).or_insert_with(|| UsageDay {
                day: date,
                ..UsageDay::default()
            });
            day.totals.add(tokens, calls, cost, recorded);
            *day.agents.entry(agent).or_default() += tokens.total();
            *day.agent_costs.entry(agent).or_default() += cost.unwrap_or(0.0);
            *day.agent_priced_calls.entry(agent).or_default() +=
                if cost.is_some() { calls } else { 0 };
            let model = day.models.entry(key).or_default();
            model.tokens += tokens.total();
            model.cost += cost.unwrap_or(0.0);
        }
    }
    let counts = format!(
        "{CANONICAL} SELECT COUNT(DISTINCT r.id),COUNT(DISTINCT NULLIF(r.cwd,'')),COUNT(DISTINCT r.agent) FROM canonical r WHERE {SCOPE} AND EXISTS(SELECT 1 FROM history_usage u WHERE u.source=r.source AND {USAGE})"
    );
    (
        report.session_count,
        report.project_count,
        report.agent_count,
    ) = db.query_row(&counts, params![agents, raw], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    report.days = days.into_values().collect();
    report.models = models.into_values().collect();
    report
        .models
        .sort_by_key(|m| std::cmp::Reverse(m.totals.total));
    Ok(report)
}
pub fn tools(index: &Index, scope: &HistoryScope) -> Result<Vec<ToolUsage>> {
    let agents = enabled(index)?;
    let db = index.db.lock()?;
    let raw = serde_json::to_string(scope)?;
    let mut statement=db.prepare(&format!("{CANONICAL} SELECT t.name,SUM(t.calls),SUM(t.failures),SUM(t.completed),SUM(t.timed),SUM(t.duration),json_group_array(DISTINCT r.agent) FROM history_tools t JOIN canonical r ON r.source=t.source WHERE {SCOPE}
      AND (json_extract(?2,'$.start') IS NULL OR r.updated>=json_extract(?2,'$.start'))
      AND (json_extract(?2,'$.end') IS NULL OR r.updated<json_extract(?2,'$.end')) GROUP BY t.name ORDER BY SUM(t.calls) DESC,t.name"))?;
    let rows = statement
        .query_map(params![agents, raw], |row| {
            Ok((
                ToolStats {
                    name: row.get(0)?,
                    calls: row.get(1)?,
                    failures: row.get(2)?,
                    completed: row.get(3)?,
                    timed: row.get(4)?,
                    duration_ms: unsigned(row, 5)?,
                },
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(stats, raw)| {
            let mut agents: Vec<Agent> = serde_json::from_str(&raw)?;
            agents.sort();
            Ok(ToolUsage { stats, agents })
        })
        .collect()
}

// Export under one database read lock so indexing cannot mix pages from different
// revisions. Only lightweight rows are decoded; response usage stays native.
pub fn export_sessions(index: &Index, query: &SessionQuery) -> Result<String> {
    use std::fmt::Write;
    let agents = enabled(index)?;
    let db = index.db.lock()?;
    prepare_calendar(&db)?;
    let sql = session_sql(query);
    let mut statement = db.prepare(&format!(
        "{sql} SELECT data FROM filtered ORDER BY {}",
        session_order(query)
    ))?;
    let mut content = String::from(
        "\"Session\",\"Agent\",\"Project\",\"Model\",\"Tokens\",\"Uncached input\",\"Cached input\",\"Cache writes\",\"Output\",\"Reasoning (included in output)\",\"Started\",\"Updated\",\"Elapsed ms\"",
    );
    for row in statement.query_map(
        params![
            agents,
            serde_json::to_string(&query.scope)?,
            query.search.to_lowercase(),
            serde_json::to_string(query)?
        ],
        |r| r.get::<_, String>(0),
    )? {
        let session: Session = serde_json::from_str(&row?)?;
        content.push_str("\r\n");
        let agent = match session.agent {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude Code",
            Agent::Opencode => "OpenCode",
            Agent::Pi => "Pi",
            Agent::Grok => "Grok Build",
            Agent::Antigravity => "Antigravity",
        };
        for field in [&session.title, agent, &session.cwd, &session.model] {
            content.push_str(&csv_text(field));
            content.push(',');
        }
        let tokens = session.tokens;
        write!(
            &mut content,
            "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",",
            tokens.total(),
            tokens.input,
            tokens.cache_read,
            tokens.cache_write,
            tokens.output,
            tokens.reasoning
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
        for timestamp in [session.started_at, session.updated_at] {
            let date = if timestamp > 0 {
                chrono::DateTime::from_timestamp_millis(timestamp)
                    .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            content.push_str(&csv_text(&date));
            content.push(',');
        }
        let elapsed = if session.started_at > 0 && session.updated_at >= session.started_at {
            (session.updated_at - session.started_at).to_string()
        } else {
            String::new()
        };
        content.push_str(&csv_text(&elapsed));
    }
    Ok(content)
}
fn csv_text(text: &str) -> String {
    let escaped = text.replace('"', "\"\"");
    let prefix = if text.trim_start().starts_with(['=', '+', '@', '-']) {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog, history};
    use serde_json::json;
    fn fixture() -> Result<(tempfile::TempDir, Index)> {
        let root = tempfile::tempdir()?;
        let sources = Agent::ALL
            .into_iter()
            .map(|agent| Source {
                agent,
                path: root.path().join(agent.id()).to_string_lossy().into_owned(),
                enabled: true,
            })
            .collect();
        let index = Index::open(root.path().join("index"), sources)?;
        let catalog=CatalogPayload {json:json!({"lab":{"name":"Lab","models":{"priced":{"id":"priced","name":"Priced","cost":{"input":2,"output":4,"cache_read":0.5}},"free":{"id":"free","name":"Free","cost":{"input":0}}}}}).to_string(),updated_at:1,source:CatalogSource::Cached,warning:None};
        catalog::save(&index, &catalog)?;
        Ok((root, index))
    }
    fn sample(id: &str, updated: i64) -> Session {
        Session {
            id: id.into(),
            agent: Agent::Pi,
            title: format!("Session {id}"),
            cwd: "/project".into(),
            project: "Project".into(),
            model: "priced".into(),
            started_at: 1,
            updated_at: updated,
            messages: 1,
            turns: 1,
            compactions: 0,
            tokens: Tokens::default(),
            usage: vec![],
            tools: vec![],
            limits: vec![],
            source_path: id.into(),
            parent_id: None,
            warnings: vec![],
        }
    }
    fn insert(index: &Index, source: &str, session: &Session) -> Result<()> {
        let mut db = index.db.lock()?;
        let tx = db.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO sessions VALUES(?1,?2,?3,'stamp',?4,?5)",
            params![
                source,
                session.agent.id(),
                session.id,
                session.updated_at,
                serde_json::to_string(session)?
            ],
        )?;
        history::upsert(&tx, source, session)?;
        tx.commit()?;
        Ok(())
    }
    #[test]
    fn calendar_function_matches_local_dates_across_boundaries() -> Result<()> {
        let db = Connection::open_in_memory()?;
        prepare_calendar(&db)?;
        for hour in -72..72 {
            let timestamp = 1_773_003_600_000 + hour * 3_600_000;
            let actual: String =
                db.query_row("SELECT history_day(?1)", [timestamp], |r| r.get(0))?;
            let expected = chrono::Local
                .timestamp_millis_opt(timestamp)
                .single()
                .unwrap()
                .format("%Y-%m-%d")
                .to_string();
            assert_eq!(actual, expected);
        }
        assert_eq!(
            db.query_row("SELECT history_day(0)", [], |r| r
                .get::<_, Option<String>>(0))?,
            None
        );
        Ok(())
    }
    #[test]
    fn exports_include_the_entire_filtered_order_and_escape_spreadsheet_formulas() -> Result<()> {
        let (_root, index) = fixture()?;
        for i in 0..123 {
            let mut row = sample(&format!("{i:03}"), 1000 + i);
            row.title = format!("=SUM(1,2) \"{i}\"");
            insert(&index, &row.id, &row)?;
        }
        let query = SessionQuery {
            offset: 100,
            limit: 20,
            activity_after: Some(1003),
            activity_before: Some(1113),
            ..Default::default()
        };
        let page = sessions(&index, &query)?;
        assert_eq!(page.total, 110);
        assert_eq!(page.sessions.len(), 10);
        let csv = export_sessions(&index, &query)?;
        let lines: Vec<_> = csv.split("\r\n").collect();
        assert_eq!(lines.len(), 111);
        assert!(lines[1].starts_with("\"'=SUM(1,2) \"\"112\"\"\","));
        assert!(
            lines
                .last()
                .unwrap()
                .starts_with("\"'=SUM(1,2) \"\"3\"\"\",")
        );
        Ok(())
    }
    #[test]
    fn log_allowances_are_bounded_to_the_current_window_and_recent_minutes() -> Result<()> {
        let (_root, index) = fixture()?;
        let mut session = sample("allowances", 40_000_000);
        session.limits = (0..500)
            .map(|minute| QuotaSample {
                agent: Agent::Pi,
                account_key: None,
                bucket: "weekly".into(),
                label: "Weekly".into(),
                used_percent: 50.0,
                window_minutes: 10080,
                resets_at: Some(99_000_000),
                timestamp: 1_000_000 + minute * 60_000,
                source: "Session log".into(),
            })
            .collect();
        insert(&index, "allowances", &session)?;
        let recent = allowances(&index)?;
        assert_eq!(recent.len(), 361);
        assert_eq!(
            recent.last().unwrap().timestamp,
            session.limits.last().unwrap().timestamp
        );
        let mut next = session.limits.last().unwrap().clone();
        next.timestamp += 60_000;
        next.resets_at = Some(199_000_000);
        session.limits.push(next);
        insert(&index, "allowances", &session)?;
        assert_eq!(allowances(&index)?.len(), 1);
        Ok(())
    }
    #[test]
    fn paging_sorting_navigation_and_enabled_deduplication_agree() -> Result<()> {
        let (_root, index) = fixture()?;
        for i in 0..120 {
            let s = sample(&format!("{i:03}"), 1000);
            insert(&index, &s.id, &s)?;
        }
        let duplicate = sample("000", 2000);
        insert(&index, "new-copy", &duplicate)?;
        let first = sessions(&index, &SessionQuery::default())?;
        assert_eq!(first.total, 120);
        let status = index.history_status()?;
        assert_eq!(status.session_count, 120);
        assert_eq!(status.longest_session, Some(1999));
        assert_eq!(
            status
                .sources
                .iter()
                .map(|source| source.sessions)
                .sum::<u32>(),
            120
        );
        assert_eq!(first.sessions.len(), 50);
        assert_eq!(first.sessions[0].id, "000");
        assert!(
            first
                .sessions
                .iter()
                .all(|s| s.usage.is_empty() && s.limits.is_empty())
        );
        let second = sessions(
            &index,
            &SessionQuery {
                offset: 50,
                ..SessionQuery::default()
            },
        )?;
        assert_eq!(second.sessions[0].id, "050");
        let nav = navigation(&index, &SessionQuery::default(), "049")?;
        assert_eq!(nav.previous.as_deref(), Some("048"));
        assert_eq!(nav.next.as_deref(), Some("050"));
        assert_eq!(nav.position, Some(49));
        let page = sessions(
            &index,
            &SessionQuery {
                search: "SESSION 11".into(),
                ..SessionQuery::default()
            },
        )?;
        assert_eq!(page.total, 10);
        let mut config = index.sources()?;
        config
            .iter_mut()
            .find(|s| s.agent == Agent::Pi)
            .unwrap()
            .enabled = false;
        index.set_sources(config)?;
        assert_eq!(sessions(&index, &SessionQuery::default())?.total, 0);
        let status = index.history_status()?;
        assert_eq!(status.session_count, 0);
        assert_eq!(status.longest_session, None);
        assert!(status.sources.iter().all(|source| source.sessions == 0));
        Ok(())
    }
    #[test]
    fn aggregates_preserve_recorded_free_unknown_and_undated_usage() -> Result<()> {
        let (_root, index) = fixture()?;
        let mut session = sample("mixed", 2_000_000);
        for (model, provider, timestamp, input, cache_write, reported_cost) in [
            ("priced", "lab", 1_000_000, 1_000_000, 0, None),
            ("priced", "lab", 1_000_000, 1_000_000, 1, None),
            ("missing", "missing", 1_000_000, 1_000_000, 0, Some(3.0)),
            ("free", "lab", 1_000_000, 1_000_000, 0, None),
            ("unknown", "missing", 1_000_000, 1_000_000, 0, None),
            ("priced", "lab", 0, 1_000_000, 0, Some(0.0)),
        ] {
            session.usage.push(Usage {
                timestamp,
                model: model.into(),
                provider: provider.into(),
                tokens: Tokens {
                    input,
                    cache_write,
                    reasoning: 100,
                    ..Tokens::default()
                },
                reported_cost,
            });
        }
        insert(&index, "mixed", &session)?;
        let lifetime = usage(&index, &HistoryScope::default())?;
        assert_eq!(lifetime.totals.calls, 6);
        assert_eq!(lifetime.totals.total, 6_000_001);
        assert_eq!(lifetime.totals.priced_calls, 4);
        assert_eq!(lifetime.totals.unpriced_calls, 2);
        assert_eq!(lifetime.totals.recorded_cost, 3.0);
        assert_eq!(lifetime.totals.estimated_cost, 2.0);
        assert_eq!(lifetime.totals.cost, 5.0);
        assert_eq!(lifetime.totals.undated_calls, 1);
        assert_eq!(lifetime.session_count, 1);
        assert_eq!(lifetime.project_count, 1);
        let period = usage(
            &index,
            &HistoryScope {
                start: Some(500_000),
                end: Some(1_500_000),
                ..HistoryScope::default()
            },
        )?;
        assert_eq!(period.totals.calls, 5);
        assert_eq!(period.totals.priced_calls, 3);
        assert_eq!(period.totals.undated_calls, 1);
        assert_eq!(
            period.days.iter().map(|d| d.totals.total).sum::<u64>(),
            5_000_001
        );
        let matched = sessions(
            &index,
            &SessionQuery {
                usage_only: true,
                scope: HistoryScope {
                    start: Some(500_000),
                    end: Some(1_500_000),
                    offerings: vec!["lab/free".into()],
                    ..HistoryScope::default()
                },
                ..SessionQuery::default()
            },
        )?;
        assert_eq!(matched.total, 1);
        assert_eq!(matched.usage["mixed"].calls, 1);
        assert_eq!(matched.usage["mixed"].tokens.input, 1_000_000);
        Ok(())
    }
    #[test]
    fn tool_agents_are_distinct_and_follow_the_same_scope_as_counts() -> Result<()> {
        let (_root, index) = fixture()?;
        for (id, agent, updated, cwd) in [
            ("codex-one", Agent::Codex, 1000, "/project"),
            ("codex-two", Agent::Codex, 1000, "/project"),
            ("claude", Agent::Claude, 1000, "/project"),
            ("old", Agent::Pi, 100, "/project"),
            ("other", Agent::Opencode, 1000, "/other"),
        ] {
            let mut session = sample(id, updated);
            session.agent = agent;
            session.cwd = cwd.into();
            session.tools.push(ToolStats {
                name: "exec".into(),
                calls: 2,
                ..Default::default()
            });
            insert(&index, id, &session)?;
        }
        let mut scope = HistoryScope {
            start: Some(500),
            project: Some("/project".into()),
            ..Default::default()
        };
        let rows = tools(&index, &scope)?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].stats.calls, 6);
        assert_eq!(rows[0].agents, vec![Agent::Codex, Agent::Claude]);
        scope.agent = Some(Agent::Claude);
        let rows = tools(&index, &scope)?;
        assert_eq!(rows[0].stats.calls, 2);
        assert_eq!(rows[0].agents, vec![Agent::Claude]);
        Ok(())
    }
    #[test]
    fn tool_and_activity_filters_do_not_reinterpret_usage_dates() -> Result<()> {
        let (_root, index) = fixture()?;
        let mut session = sample("tools", 2_000_000);
        session.tools.push(ToolStats {
            name: "exec".into(),
            calls: 4,
            failures: 1,
            completed: 3,
            timed: 2,
            duration_ms: 500,
        });
        session.usage.push(Usage {
            timestamp: 1_000_000,
            model: "priced".into(),
            provider: "lab".into(),
            tokens: Tokens {
                input: 1_000_000,
                ..Tokens::default()
            },
            reported_cost: None,
        });
        insert(&index, "tools", &session)?;
        assert_eq!(
            sessions(
                &index,
                &SessionQuery {
                    tool: Some("exec".into()),
                    failed_only: true,
                    ..SessionQuery::default()
                }
            )?
            .total,
            1
        );
        assert_eq!(
            sessions(
                &index,
                &SessionQuery {
                    tool: Some("missing".into()),
                    failed_only: true,
                    ..SessionQuery::default()
                }
            )?
            .total,
            0
        );
        let scope = HistoryScope {
            start: Some(500_000),
            end: Some(1_500_000),
            ..HistoryScope::default()
        };
        assert_eq!(usage(&index, &scope)?.totals.calls, 1);
        assert!(tools(&index, &scope)?.is_empty());
        assert_eq!(
            tools(&index, &HistoryScope::default())?[0].stats.failures,
            1
        );
        Ok(())
    }
}
