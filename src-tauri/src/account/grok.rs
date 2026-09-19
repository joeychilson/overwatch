//! Grok: the usage pool of a SuperGrok plan.
//!
//! Grok Build, OpenCode and Pi all sign in with the Grok CLI's xAI client, so a
//! token from any of them reads the same pool, which every Grok product shares.
//! The token is a JWT whose `sub` is the account. The billing endpoint belongs
//! to the proxy the Grok CLI talks to, which refuses a request that does not
//! name a CLI client and version.

use serde_json::Value;

use super::{Identity, Location, OPENCODE, PI, Reader, Source, Usage};
use crate::session::{Limit, Problem};
use crate::timestamp::from_json;

const URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/// A released Grok CLI version, which the proxy requires a client to name.
const CLIENT_VERSION: &str = "1.0.30";

/// Grok Build keys its sign-in by issuer and client, and the client is fixed.
const GROK_BUILD_TOKEN: &str = "/https:~1~1auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828/key";
const GROK_BUILD_EXPIRES: &str =
    "/https:~1~1auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828/expires_at";

/// Where a SuperGrok sign-in can be kept, and how its pool is read.
pub(super) const READER: Reader = Reader {
    sources: &[
        Source {
            app: "Grok Build",
            location: Location::File(".grok/auth.json"),
            token: GROK_BUILD_TOKEN,
            expires: Some(GROK_BUILD_EXPIRES),
            plan: None,
        },
        Source {
            app: "OpenCode",
            location: Location::File(OPENCODE),
            token: "/xai/access",
            expires: Some("/xai/expires"),
            plan: None,
        },
        Source {
            app: "Pi",
            location: Location::File(PI),
            token: "/xai/access",
            expires: Some("/xai/expires"),
            plan: None,
        },
    ],
    identity,
    fetch,
};

/// The account a token was issued to.
fn identity(token: &str) -> Identity {
    Identity {
        key: super::claims(token)["sub"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        label: None,
    }
}

/// Ask for the pool a token draws on, as the Grok CLI does.
fn fetch(token: &str, _identity: &Identity, _now: i64) -> Result<Usage, Problem> {
    let headers = [
        format!("Authorization: Bearer {token}"),
        "X-XAI-Token-Auth: xai-grok-cli".to_owned(),
        "x-grok-client-identifier: grok-shell".to_owned(),
        format!("x-grok-client-version: {CLIENT_VERSION}"),
        "User-Agent: xai-grok-cli".to_owned(),
    ];
    super::get(URL, &headers, parse)
}

/// The pool in a billing answer: how much is used, and when the period ends.
fn parse(body: &Value) -> Option<Usage> {
    let config = &body["config"];
    let used_percent = super::percent(&config["creditUsagePercent"])?;
    let period = &config["currentPeriod"];
    let (start, end) = (from_json(&period["start"]), from_json(&period["end"]));
    let length = start
        .zip(end)
        .and_then(|(start, end)| end.checked_sub(start))
        .filter(|length| *length > 0);
    let limit = Limit {
        name: length.map_or_else(|| "Usage".to_owned(), |length| super::span(length / 1_000)),
        scope: None,
        used_percent,
        resets_at: end,
        runs_out_at: None,
    };
    super::usage(None, vec![limit])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_pool_is_read_with_its_period() {
        // Shaped after what the Grok CLI logs for this endpoint.
        let body = json!({"config": {
            "creditUsagePercent": 1.0,
            "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_WEEKLY",
                "start": "2026-09-08T19:28:21.395528+00:00",
                "end": "2026-09-15T19:28:21.395528+00:00"
            }
        }});
        let usage = parse(&body).expect("reads");
        assert_eq!(usage.limits.len(), 1);
        assert_eq!(usage.limits[0].name, "Weekly");
        assert_eq!(usage.limits[0].used_percent, 1.0);
        // Twelve days and 19:28:21.395 after 2026-09-03T00:00:00Z, which is
        // 1_788_393_600 seconds.
        assert_eq!(usage.limits[0].resets_at, Some(1_789_500_501_395));
    }

    #[test]
    fn grok_builds_sign_in_is_found_under_its_client() {
        let kept = json!({"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
            "key": "token",
            "expires_at": "2026-09-13T13:17:12Z"
        }});
        assert_eq!(kept.pointer(GROK_BUILD_TOKEN), Some(&json!("token")));
        assert!(kept.pointer(GROK_BUILD_EXPIRES).is_some());
    }
}
