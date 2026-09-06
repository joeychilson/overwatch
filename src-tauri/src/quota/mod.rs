mod normalize;

use crate::{
    credentials::{self, Credential},
    data::*,
    error::{AppError, Result},
    index::Index,
};
use reqwest::{Client, RequestBuilder, StatusCode};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

pub use normalize::normalize;

pub struct Quotas {
    client: Client,
    locks: HashMap<Agent, tokio::sync::Mutex<()>>,
}
impl Quotas {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: client()?,
            locks: Agent::ALL
                .into_iter()
                .map(|a| (a, tokio::sync::Mutex::new(())))
                .collect(),
        })
    }
    pub async fn lock(&self, agent: Agent) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        let lock = self
            .locks
            .get(&agent)
            .ok_or_else(|| AppError::Unsupported("Unknown quota provider".into()))?;
        Ok(lock.lock().await)
    }
    pub async fn refresh(
        &self,
        index: Arc<Index>,
        agent: Agent,
        interactive: bool,
    ) -> Result<AccountStatus> {
        let _guard = self.lock(agent).await?;
        let root = index
            .sources()?
            .into_iter()
            .find(|s| s.agent == agent)
            .ok_or_else(|| AppError::NotFound("Provider source missing".into()))?
            .path;
        let previous = status(&index, agent, &root)?;
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(previous) = &previous
            && (now - previous.last_attempt < 30_000
                || (!interactive && previous.next_refresh_at > now))
        {
            return Ok(previous.clone());
        }
        let credential_root = root.clone();
        let credential = tauri::async_runtime::spawn_blocking(move || {
            credentials::load(agent, std::path::Path::new(&credential_root), interactive)
        })
        .await
        .map_err(|_| AppError::Internal("Credential task interrupted".into()))?;
        let reading = match credential {
            Ok(credential) => self.fetch(agent, credential, now).await,
            Err(error) => Err(error),
        };
        let mut result = previous.unwrap_or(AccountStatus {
            agent,
            usage: None,
            error: None,
            last_attempt: 0,
            next_refresh_at: 0,
        });
        let delay = (result.next_refresh_at - result.last_attempt)
            .saturating_mul(2)
            .clamp(300_000, 1_800_000);
        result.last_attempt = now;
        match reading {
            Ok(usage) => {
                result.usage = Some(usage);
                result.error = None;
                result.next_refresh_at = now + 300_000;
            }
            Err(error) => {
                result.error = Some(error);
                result.next_refresh_at = now + delay;
            }
        }
        persist(&index, &root, &result)?;
        Ok(result)
    }
    async fn fetch(&self, agent: Agent, credential: Credential, now: i64) -> Result<AccountUsage> {
        let request = match agent {
            Agent::Codex => {
                let request = self
                    .client
                    .get("https://chatgpt.com/backend-api/wham/usage");
                match &credential.account_id {
                    Some(id) => request.header("ChatGPT-Account-Id", id),
                    None => request,
                }
            }
            Agent::Claude => self
                .client
                .get("https://api.anthropic.com/api/oauth/usage")
                .header("anthropic-beta", "oauth-2025-04-20"),
            Agent::Opencode => self.client.get("https://opencode.ai/zen/go/v1/usage"),
            Agent::Grok => self
                .client
                .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
                .header("x-xai-token-auth", "xai-grok-cli"),
            Agent::Antigravity => {
                let project = response(
                    self.client
                        .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
                        .bearer_auth(&credential.token)
                        .json(&json!({"metadata":{"ideType":"ANTIGRAVITY"}})),
                )
                .await?;
                let id = project["cloudaicompanionProject"]
                    .as_str()
                    .or(project["cloudaicompanionProject"]["id"].as_str())
                    .ok_or_else(|| {
                        AppError::Unsupported(
                            "This Google account has no existing Antigravity project.".into(),
                        )
                    })?;
                self.client
                    .post("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
                    .json(&json!({"project":id}))
            }
            Agent::Pi => {
                return Err(AppError::Unsupported(
                    "Pi has no universal quota endpoint.".into(),
                ));
            }
        };
        let value = response(request.bearer_auth(&credential.token)).await?;
        normalize(agent, &value, credential.identity, credential.plan, now)
    }
}
pub fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Overwatch/0.1")
        .build()
        .map_err(|_| AppError::Network("Could not initialize the HTTP client.".into()))
}
pub async fn response(request: RequestBuilder) -> Result<Value> {
    let mut response = request
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            AppError::Network(
                if error.is_timeout() {
                    "The provider request timed out."
                } else {
                    "Cannot reach the provider. Check your connection."
                }
                .into(),
            )
        })?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(AppError::Unauthorized("The provider rejected this sign-in. Renew it through the provider or replace the access token.".into())),
        StatusCode::TOO_MANY_REQUESTS => return Err(AppError::RateLimited("The provider is rate limiting requests. Try again later.".into())),
        status if !status.is_success() => return Err(AppError::Network(format!("Provider returned HTTP {}.", status.as_u16()))),
        _ => {}
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::Network("Provider response interrupted.".into()))?
    {
        if body.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err(AppError::InvalidData(
                "Provider response exceeds 32 MB.".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| AppError::InvalidData("The provider returned invalid JSON.".into()))
}

fn decode_status(raw: &str) -> Result<AccountStatus> {
    let mut status: AccountStatus = serde_json::from_str(raw)?;
    if let Some(usage) = &mut status.usage {
        usage.windows.retain(|sample| !sample.is_codex_spark());
    }
    Ok(status)
}
fn status(index: &Index, agent: Agent, root: &str) -> Result<Option<AccountStatus>> {
    let raw: Option<String> = index
        .db
        .lock()?
        .query_row(
            "SELECT data FROM accounts WHERE agent=?1 AND root=?2",
            params![agent.id(), root],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| decode_status(&raw)).transpose()
}
pub fn read(index: &Index) -> Result<Accounts> {
    let db = index.db.lock()?;
    let mut query = db.prepare("SELECT data FROM accounts")?;
    let accounts = query
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|raw| decode_status(&raw?))
        .collect::<Result<Vec<_>>>()?;
    let mut query = db.prepare("SELECT data FROM samples ORDER BY minute")?;
    let mut samples = query
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|raw| Ok(serde_json::from_str(&raw?)?))
        .collect::<Result<Vec<QuotaSample>>>()?;
    samples.retain(|sample| !sample.is_codex_spark());
    Ok(Accounts { accounts, samples })
}
fn persist(index: &Index, root: &str, status: &AccountStatus) -> Result<()> {
    // Hold the source lock through the commit so a folder change cannot race
    // an in-flight request into restoring the previous account's readings.
    let sources = index.sources.lock()?;
    if !sources
        .iter()
        .any(|source| source.source.agent == status.agent && source.source.path == root)
    {
        return Err(AppError::InvalidData(
            "The provider source changed during refresh. Try again.".into(),
        ));
    }
    let mut db = index.db.lock()?;
    let tx = db.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO accounts VALUES(?1,?2,?3)",
        params![status.agent.id(), root, serde_json::to_string(status)?],
    )?;
    if status.error.is_none()
        && let Some(usage) = &status.usage
    {
        for sample in &usage.windows {
            tx.execute(
                "INSERT OR REPLACE INTO samples VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    status.agent.id(),
                    usage.account_key,
                    sample.bucket,
                    sample.resets_at.unwrap_or(0),
                    sample.timestamp / 60_000,
                    serde_json::to_string(sample)?
                ],
            )?;
        }
    }
    tx.execute(
        "DELETE FROM samples WHERE minute < ?1",
        [chrono::Utc::now().timestamp_millis() / 60_000 - 90 * 1440],
    )?;
    tx.commit()?;
    Ok(())
}
pub fn clear(index: &Index, agent: Agent) -> Result<()> {
    let mut db = index.db.lock()?;
    let tx = db.transaction()?;
    tx.execute("DELETE FROM accounts WHERE agent=?1", [agent.id()])?;
    tx.execute("DELETE FROM samples WHERE agent=?1", [agent.id()])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_ignores_spark_and_keeps_account_review_and_other_limits() -> Result<()> {
        let rate = json!({"primary_window":{"used_percent":12,"limit_window_seconds":18000}});
        let usage = normalize(
            Agent::Codex,
            &json!({
                "rate_limit": rate,
                "code_review_rate_limit": rate,
                "additional_rate_limits": [
                    {"limit_id":"codex_spark", "rate_limit":rate},
                    {"limit_id":"codex_bengalfox", "rate_limit":rate},
                    {"limit_id":"legacy", "limit_name":"GPT-5.3-Codex-Spark", "rate_limit":rate},
                    {"limit_id":"legacy-feature", "metered_feature":"gpt-5.3-codex-SPARK", "rate_limit":rate},
                    {"limit_id":"other-model", "limit_name":"Other model", "rate_limit":rate}
                ],
                "credits":{"balance":24}
            }),
            "fixture-account".into(),
            None,
            1_800_000_000_000,
        )?;
        assert_eq!(
            usage
                .windows
                .iter()
                .map(|sample| sample.bucket.as_str())
                .collect::<Vec<_>>(),
            [
                "codex:primary",
                "code-review:primary",
                "other-model:primary"
            ]
        );
        assert_eq!(usage.balances[0].remaining, Some(24.0));
        Ok(())
    }

    #[test]
    fn legacy_spark_readings_are_excluded_from_accounts_history_and_cached_sessions() -> Result<()>
    {
        let directory = tempfile::tempdir()?;
        let sources = crate::index::default_sources()?;
        let root = sources
            .iter()
            .find(|source| source.agent == Agent::Codex)
            .ok_or_else(|| AppError::Internal("Fixture source missing".into()))?
            .path
            .clone();
        let index = Index::open(directory.path().join("index"), sources)?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut usage = normalize(
            Agent::Codex,
            &json!({"rate_limit":{"primary_window":{"used_percent":42}}}),
            "fixture-account".into(),
            None,
            now,
        )?;
        let spark = QuotaSample {
            bucket: "codex_bengalfox:primary".into(),
            label: "5 hour".into(),
            ..usage.windows[0].clone()
        };
        usage.windows.push(spark);
        let mut session =
            crate::parse::Cursor::new(Agent::Codex, std::path::Path::new("legacy.jsonl"), false)
                .summary();
        session.limits = usage.windows.clone();
        let legacy = AccountStatus {
            agent: Agent::Codex,
            usage: Some(usage),
            error: None,
            last_attempt: now,
            next_refresh_at: now + 300_000,
        };
        persist(&index, &root, &legacy)?;
        index.db.lock()?.execute(
            "INSERT INTO sessions VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                "legacy.jsonl",
                "codex",
                "legacy-session",
                "legacy",
                now,
                serde_json::to_string(&session)?
            ],
        )?;
        let accounts = read(&index)?;
        assert_eq!(accounts.samples.len(), 1);
        assert_eq!(
            accounts.accounts[0]
                .usage
                .as_ref()
                .map(|usage| usage.windows.len()),
            Some(1)
        );
        assert_eq!(
            status(&index, Agent::Codex, &root)?
                .and_then(|account| account.usage)
                .map(|usage| usage.windows.len()),
            Some(1)
        );
        assert_eq!(index.snapshot()?.sessions[0].limits.len(), 1);
        assert_eq!(index.snapshot()?.sessions[0].limits[0].used_percent, 42.0);
        Ok(())
    }

    #[test]
    fn providers_normalize_units_resets_and_optional_windows() -> Result<()> {
        let now = 1_788_600_000_000i64;
        let codex = normalize(
            Agent::Codex,
            &json!({"rate_limit":{"primary_window":{"used_percent":42,"limit_window_seconds":18000,"reset_after_seconds":600}},"credits":{"balance":"12.5"}}),
            "id".into(),
            None,
            now,
        )?;
        assert_eq!(codex.windows[0].resets_at, Some(now + 600_000));
        assert_eq!(codex.windows[0].window_minutes, 300);
        assert_eq!(codex.balances[0].remaining, Some(12.5));
        let claude = normalize(
            Agent::Claude,
            &json!({"five_hour":{"utilization":12,"resets_at":"2026-09-05T20:00:00Z"},"seven_day":null,"extra_usage":{"is_enabled":true,"used_credits":550,"monthly_limit":2000}}),
            "id".into(),
            None,
            now,
        )?;
        assert_eq!(claude.windows.len(), 1);
        assert_eq!(claude.balances[0].used, Some(5.5));
        assert_eq!(claude.balances[0].remaining, Some(14.5));
        let opencode = normalize(
            Agent::Opencode,
            &json!({"usage":{"monthly":{"percent":0,"resetsAt":now+1000}}}),
            "id".into(),
            None,
            now,
        )?;
        assert_eq!(opencode.windows[0].used_percent, 0.0);
        assert_eq!(opencode.windows[0].resets_at, Some(now + 1000));
        let grok = normalize(
            Agent::Grok,
            &json!({"onDemandUsed":{"val":"20"},"onDemandCap":{"val":"80"}}),
            "id".into(),
            None,
            now,
        )?;
        assert_eq!(grok.windows[0].used_percent, 25.0);
        assert_eq!(grok.balances[0].remaining, Some(60.0));
        let google = normalize(
            Agent::Antigravity,
            &json!({"models":{"gemini":{"quotaInfo":{"remainingFraction":0.75}}}}),
            "id".into(),
            None,
            now,
        )?;
        assert_eq!(google.windows[0].used_percent, 25.0);
        for invalid in [
            json!({}),
            json!({"rate_limit":{"primary_window":{"used_percent":999}}}),
        ] {
            assert!(normalize(Agent::Codex, &invalid, "id".into(), None, now).is_err());
        }
        Ok(())
    }

    #[test]
    fn persisted_samples_deduplicate_and_cannot_restore_a_replaced_source() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let sources = crate::index::default_sources()?;
        let root = sources
            .iter()
            .find(|source| source.agent == Agent::Codex)
            .ok_or_else(|| AppError::Internal("Fixture source missing".into()))?
            .path
            .clone();
        let index = Index::open(directory.path().join("cache"), sources.clone())?;
        let now = chrono::Utc::now().timestamp_millis();
        let account = AccountStatus {
            agent: Agent::Codex,
            usage: Some(normalize(
                Agent::Codex,
                &json!({"rate_limit":{"primary_window":{"used_percent":10}}}),
                "fixture-id".into(),
                None,
                now,
            )?),
            error: None,
            last_attempt: now,
            next_refresh_at: now + 300_000,
        };
        persist(&index, &root, &account)?;
        persist(&index, &root, &account)?;
        assert_eq!(read(&index)?.samples.len(), 1);
        let mut changed = sources;
        for source in &mut changed {
            if source.agent == Agent::Codex {
                source.path = directory.path().to_string_lossy().into_owned();
            }
        }
        index.set_sources(changed)?;
        assert!(persist(&index, &root, &account).is_err());
        assert!(read(&index)?.samples.is_empty());
        assert!(read(&index)?.accounts.is_empty());
        Ok(())
    }
}
