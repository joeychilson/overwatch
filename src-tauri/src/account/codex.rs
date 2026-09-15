//! Codex: the limits of a ChatGPT plan.
//!
//! Codex, OpenCode and Pi all sign in with the same OpenAI client, so a token
//! from any of them reads the same usage. The token is a JWT naming the
//! workspace it was issued for and the person's email address. Each limit is a
//! window of `limit_window_seconds` with `used_percent` and `reset_at` in Unix
//! seconds; limits on particular models arrive in `additional_rate_limits`.

use serde_json::Value;

use super::{Identity, Location, OPENCODE, PI, Reader, Source, Usage};
use crate::session::{Limit, Problem};

const URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// Where a ChatGPT sign-in can be kept, and how its limits are read.
pub(super) const READER: Reader = Reader {
    sources: &[
        Source {
            app: "Codex",
            location: Location::File(".codex/auth.json"),
            token: "/tokens/access_token",
            expires: None,
            plan: None,
        },
        Source {
            app: "OpenCode",
            location: Location::File(OPENCODE),
            token: "/openai/access",
            expires: Some("/openai/expires"),
            plan: None,
        },
        Source {
            app: "Pi",
            location: Location::File(PI),
            token: "/openai-codex/access",
            expires: Some("/openai-codex/expires"),
            plan: None,
        },
    ],
    identity,
    fetch,
};

/// The workspace a token was issued for, labelled with its owner's email.
fn identity(token: &str) -> Identity {
    let claims = super::claims(token);
    Identity {
        key: claims["https://api.openai.com/auth"]["chatgpt_account_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        label: claims["https://api.openai.com/profile"]["email"]
            .as_str()
            .map(str::to_owned),
    }
}

/// Ask for the limits of the workspace a token was issued for.
fn fetch(token: &str, identity: &Identity, now: i64) -> Result<Usage, Problem> {
    let mut headers = vec![format!("Authorization: Bearer {token}")];
    // Selects the workspace when one person belongs to several.
    if !identity.key.is_empty() {
        headers.push(format!("ChatGPT-Account-Id: {}", identity.key));
    }
    super::get(URL, &headers, |body| parse(body, now))
}

/// The limits in a usage answer.
fn parse(body: &Value, now: i64) -> Option<Usage> {
    let mut limits = windows(&body["rate_limit"], None, now);
    for extra in body["additional_rate_limits"]
        .as_array()
        .into_iter()
        .flatten()
    {
        limits.extend(windows(
            &extra["rate_limit"],
            extra["limit_name"].as_str(),
            now,
        ));
    }
    let plan = body["plan_type"].as_str().map(str::to_owned);
    super::usage(plan, limits)
}

/// The windows of one rate limit, and the model it applies to, if only one.
fn windows(rate: &Value, scope: Option<&str>, now: i64) -> Vec<Limit> {
    ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| {
            let window = &rate[key];
            let seconds = window["limit_window_seconds"]
                .as_i64()
                .filter(|seconds| *seconds > 0)?;
            Some(Limit {
                name: super::span(seconds),
                scope: scope.map(str::to_owned),
                runs_out_at: None,
                used_percent: super::percent(&window["used_percent"])?,
                // An unknown reset instant arrives as zero; the countdown
                // beside it still says when.
                resets_at: window["reset_at"]
                    .as_i64()
                    .and_then(crate::timestamp::from_unix_number)
                    .or_else(|| {
                        window["reset_after_seconds"]
                            .as_i64()
                            .filter(|seconds| *seconds >= 0)
                            .map(|seconds| now + seconds * 1_000)
                    }),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;

    const NOW: i64 = 1_788_420_000_000;

    #[test]
    fn every_window_is_read_including_limits_on_one_model() {
        let body = json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 42,
                    "limit_window_seconds": 18_000,
                    "reset_after_seconds": 3_600,
                    "reset_at": 1_788_423_600
                },
                "secondary_window": {
                    "used_percent": 56,
                    "limit_window_seconds": 604_800,
                    "reset_after_seconds": 518_400,
                    "reset_at": 0
                }
            },
            "additional_rate_limits": [{
                "limit_name": "GPT-5.3-Codex-Spark",
                "metered_feature": "codex_spark",
                "rate_limit": {
                    "allowed": true,
                    "limit_reached": false,
                    "primary_window": {
                        "used_percent": 10,
                        "limit_window_seconds": 604_800,
                        "reset_after_seconds": 60,
                        "reset_at": 1_788_420_060
                    }
                }
            }],
            "credits": {"has_credits": false, "unlimited": false, "balance": "0"}
        });
        let usage = parse(&body, NOW).expect("reads");
        assert_eq!(usage.plan.as_deref(), Some("pro"));
        let names: Vec<&str> = usage
            .limits
            .iter()
            .map(|limit| limit.name.as_str())
            .collect();
        assert_eq!(names, ["5 hours", "Weekly", "Weekly"]);
        // The plan's own windows limit all usage; the extra one limits a model.
        assert_eq!(usage.limits[1].scope, None);
        assert_eq!(
            usage.limits[2].scope.as_deref(),
            Some("GPT-5.3-Codex-Spark")
        );
        assert_eq!(usage.limits[0].used_percent, 42.0);
        assert_eq!(usage.limits[0].resets_at, Some(1_788_423_600_000));
        assert_eq!(usage.limits[1].resets_at, Some(NOW + 518_400_000));
    }

    #[test]
    fn an_answer_without_windows_is_not_a_reading() {
        let body = json!({"plan_type": "free", "rate_limit": null});
        assert!(parse(&body, NOW).is_none());
    }

    #[test]
    fn a_token_names_its_workspace_and_owner() {
        let payload = json!({
            "https://api.openai.com/auth": {"chatgpt_account_id": "workspace-1"},
            "https://api.openai.com/profile": {"email": "joey@example.com"}
        });
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        let identity = identity(&token);
        assert_eq!(identity.key, "workspace-1");
        assert_eq!(identity.label.as_deref(), Some("joey@example.com"));
    }
}
