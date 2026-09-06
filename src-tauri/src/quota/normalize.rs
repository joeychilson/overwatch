use crate::{
    data::*,
    error::{AppError, Result},
    parse::time,
};
use serde_json::Value;

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
}
fn percent(value: &Value) -> Option<f64> {
    number(value).filter(|n| *n <= 100.0)
}
fn reset(value: &Value) -> Option<i64> {
    let time = time(value);
    (time > 0).then_some(time)
}

pub fn normalize(
    agent: Agent,
    value: &Value,
    identity: String,
    plan: Option<String>,
    now: i64,
) -> Result<AccountUsage> {
    let source = match agent {
        Agent::Codex => "OpenAI account",
        Agent::Claude => "Anthropic account",
        Agent::Opencode => "OpenCode Go account",
        Agent::Grok => "Grok account",
        Agent::Antigravity => "Google account",
        Agent::Pi => return Err(AppError::Unsupported("Pi has no quota endpoint.".into())),
    };
    let mut usage = AccountUsage {
        account_key: identity,
        plan,
        updated_at: now,
        source: source.into(),
        windows: vec![],
        balances: vec![],
    };
    let mut window =
        |bucket: String, label: String, used: Option<f64>, minutes: u32, resets_at: Option<i64>| {
            if let Some(used_percent) = used {
                usage.windows.push(QuotaSample {
                    agent,
                    account_key: Some(usage.account_key.clone()),
                    bucket,
                    label,
                    used_percent,
                    window_minutes: minutes,
                    resets_at,
                    timestamp: now,
                    source: source.into(),
                });
            }
        };
    match agent {
        Agent::Codex => {
            usage.plan = value["plan_type"]
                .as_str()
                .map(str::to_owned)
                .or(usage.plan);
            let mut rates = vec![
                ("codex", "", &value["rate_limit"]),
                (
                    "code-review",
                    "Code review",
                    &value["code_review_rate_limit"],
                ),
            ];
            if let Some(extra) = value["additional_rate_limits"].as_array() {
                for item in extra {
                    if ["limit_id", "metered_feature", "limit_name"]
                        .iter()
                        .any(|key| item[key].as_str().is_some_and(is_spark_limit))
                    {
                        continue;
                    }
                    if let Some(id) = item["limit_id"]
                        .as_str()
                        .or(item["metered_feature"].as_str())
                    {
                        rates.push((
                            id,
                            item["limit_name"].as_str().unwrap_or(id),
                            &item["rate_limit"],
                        ));
                    }
                }
            }
            for (id, name, rate) in rates {
                for key in ["primary", "secondary"] {
                    let value = &rate[format!("{key}_window")];
                    let seconds = value["limit_window_seconds"].as_u64().unwrap_or(0);
                    let label = if seconds == 604800 {
                        "Weekly".into()
                    } else if seconds > 0 {
                        format!("{} hour", seconds / 3600)
                    } else {
                        "Allowance".into()
                    };
                    let resets = reset(&value["reset_at"]).or_else(|| {
                        value["reset_after_seconds"]
                            .as_i64()
                            .filter(|n| *n >= 0)
                            .map(|seconds| now.saturating_add(seconds.saturating_mul(1000)))
                    });
                    window(
                        format!("{id}:{key}"),
                        if name.is_empty() {
                            label
                        } else {
                            format!("{name} · {label}")
                        },
                        percent(&value["used_percent"]),
                        (seconds / 60) as u32,
                        resets,
                    );
                }
            }
            let credits = &value["credits"];
            if number(&credits["balance"]).is_some() || credits["unlimited"] == true {
                usage.balances.push(Balance {
                    label: "Credits".into(),
                    used: None,
                    limit: None,
                    remaining: number(&credits["balance"]),
                    unit: "credits".into(),
                    unlimited: credits["unlimited"] == true,
                });
            }
        }
        Agent::Claude => {
            for (id, label, minutes) in [
                ("five_hour", "5 hour", 300),
                ("seven_day", "Weekly", 10080),
                ("seven_day_sonnet", "Sonnet · Weekly", 10080),
                ("seven_day_opus", "Opus · Weekly", 10080),
                ("seven_day_cowork", "Cowork · Weekly", 10080),
                ("seven_day_routines", "Routines · Weekly", 10080),
            ] {
                window(
                    id.into(),
                    label.into(),
                    percent(&value[id]["utilization"]),
                    minutes,
                    reset(&value[id]["resets_at"]),
                );
            }
            let extra = &value["extra_usage"];
            if extra["is_enabled"] == true {
                let used = number(&extra["used_credits"]).map(|n| n / 100.0);
                let limit = number(&extra["monthly_limit"]).map(|n| n / 100.0);
                usage
                    .balances
                    .push(balance("Monthly extra usage", used, limit, "USD"));
            }
        }
        Agent::Opencode => {
            usage.plan = Some("OpenCode Go".into());
            for (id, label, minutes) in [
                ("rolling", "5 hour", 300),
                ("weekly", "Weekly", 10080),
                ("monthly", "Monthly", 0),
            ] {
                window(
                    id.into(),
                    label.into(),
                    percent(&value["usage"][id]["percent"]),
                    minutes,
                    reset(&value["usage"][id]["resetsAt"]),
                );
            }
        }
        Agent::Grok => {
            let config = &value["config"];
            let used = number(&value["onDemandUsed"]["val"]);
            let limit = number(&value["onDemandCap"]["val"]);
            let resets = reset(&config["currentPeriod"]["end"])
                .or_else(|| reset(&config["billingPeriodEnd"]));
            let minutes = reset(&config["currentPeriod"]["start"])
                .zip(resets)
                .map(|(start, end)| end.saturating_sub(start).max(0) as u64 / 60_000)
                .unwrap_or(0) as u32;
            let used_percent = percent(&config["creditUsagePercent"]).or_else(|| {
                used.zip(limit)
                    .filter(|(_, limit)| *limit > 0.0)
                    .map(|(used, limit)| (used / limit * 100.0).min(100.0))
            });
            window(
                "credits".into(),
                "Billing period".into(),
                used_percent,
                minutes,
                resets,
            );
            if used.is_some() || limit.is_some() {
                usage
                    .balances
                    .push(balance("On-demand usage", used, limit, "credits"));
            }
        }
        Agent::Antigravity => {
            if let Some(models) = value["models"].as_object() {
                for (id, model) in models {
                    window(
                        id.into(),
                        model["displayName"].as_str().unwrap_or(id).into(),
                        number(&model["quotaInfo"]["remainingFraction"])
                            .filter(|n| *n <= 1.0)
                            .map(|n| (1.0 - n) * 100.0),
                        0,
                        reset(&model["quotaInfo"]["resetTime"]),
                    );
                }
            }
        }
        Agent::Pi => {}
    }
    if usage.windows.is_empty() && usage.balances.is_empty() {
        return Err(AppError::InvalidData("The provider returned no supported usage readings. Its response format or your plan may have changed.".into()));
    }
    Ok(usage)
}
fn balance(label: &str, used: Option<f64>, limit: Option<f64>, unit: &str) -> Balance {
    Balance {
        label: label.into(),
        used,
        limit,
        remaining: used.zip(limit).map(|(used, limit)| (limit - used).max(0.0)),
        unit: unit.into(),
        unlimited: false,
    }
}
