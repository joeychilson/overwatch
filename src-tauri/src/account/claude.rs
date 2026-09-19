//! Claude: the limits of a Claude plan.
//!
//! Only Claude Code holds a Claude sign-in, because Anthropic does not allow
//! its plans in other agents. Claude Code keeps it in the login Keychain as
//! `Claude Code-credentials`, with the plan beside the token.

use serde_json::Value;

use super::{Identity, Location, Reader, Source, Usage};
use crate::session::Problem;
use crate::timestamp::from_json;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Where a Claude sign-in is kept, and how its limits are read.
pub(super) const READER: Reader = Reader {
    sources: &[Source {
        app: "Claude Code",
        location: Location::Keychain("Claude Code-credentials"),
        token: "/claudeAiOauth/accessToken",
        expires: Some("/claudeAiOauth/expiresAt"),
        plan: Some("/claudeAiOauth/subscriptionType"),
    }],
    identity,
    fetch,
};

/// Claude's tokens do not say whose they are, so its one sign-in is one
/// account.
fn identity(_token: &str) -> Identity {
    Identity {
        key: String::new(),
        label: None,
    }
}

/// Ask for the limits of the plan a token belongs to.
fn fetch(token: &str, _identity: &Identity, _now: i64) -> Result<Usage, Problem> {
    super::get(URL, token, &["anthropic-beta: oauth-2025-04-20"], parse)
}

/// Five hours, in milliseconds.
const FIVE_HOURS: i64 = 5 * 3_600_000;
/// A week, in milliseconds.
const WEEK: i64 = 7 * 24 * 3_600_000;

/// The limits in a usage answer.
///
/// Windows are keyed by length (`five_hour`, `seven_day`) and, for a limit on
/// one model, by `seven_day_` and the model. A window the plan does not have is
/// null and is skipped.
fn parse(body: &Value) -> Option<Usage> {
    let limits = body
        .as_object()?
        .iter()
        .filter_map(|(key, window)| {
            let (name, scope, length) = match key.as_str() {
                "five_hour" => ("5 hours", None, FIVE_HOURS),
                "seven_day" => ("Weekly", None, WEEK),
                other => (
                    "Weekly",
                    Some(words(other.strip_prefix("seven_day_")?)),
                    WEEK,
                ),
            };
            super::limit(
                name.to_owned(),
                scope,
                &window["utilization"],
                super::ending(from_json(&window["resets_at"]), length),
            )
        })
        .collect();
    super::usage(None, limits)
}

/// A key such as `oauth_apps` as words: `Oauth apps`.
fn words(key: &str) -> String {
    let spaced = key.replace('_', " ");
    let mut characters = spaced.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_are_read_by_length_and_by_model() {
        let body = json!({
            "five_hour": {"utilization": 12.0, "resets_at": "2026-09-08T18:00:00Z"},
            "seven_day": null,
            "seven_day_opus": {"utilization": 3.5, "resets_at": "2026-09-12T07:00:00+00:00"},
            "extra_usage": {"is_enabled": true, "monthly_limit": 2000, "used_credits": 550}
        });
        let usage = parse(&body).expect("reads");
        let names: Vec<&str> = usage
            .limits
            .iter()
            .map(|limit| limit.name.as_str())
            .collect();
        // A null window is one the plan lacks, and spend is not a window.
        assert_eq!(names, ["5 hours", "Weekly"]);
        assert_eq!(usage.limits[0].scope, None);
        assert_eq!(usage.limits[1].scope.as_deref(), Some("Opus"));
        assert_eq!(usage.limits[0].used_percent, 12.0);
        // Five days and eighteen hours after 2026-09-03T00:00:00Z, which is
        // 1_788_393_600 seconds.
        assert_eq!(usage.limits[0].resets_at, Some(1_788_890_400_000));
        // Windows are as long as their keys say: this one began at 13:00, and
        // the Opus week at 2026-09-05T07:00:00Z, two days and seven hours in.
        assert_eq!(usage.limits[0].starts_at, Some(1_788_872_400_000));
        assert_eq!(usage.limits[1].starts_at, Some(1_788_591_600_000));
    }
}
