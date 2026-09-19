//! OpenCode Go: the Go plan's rolling, weekly and monthly limits.
//!
//! OpenCode and Pi both keep the plan's API key under `opencode-go`. A key is
//! its own identity, so the same key in both apps is one account; only a hash
//! of it is kept, so the key itself never reaches the index.

use serde_json::Value;

use super::{Identity, Location, OPENCODE, PI, Reader, Source, Usage};
use crate::session::Problem;
use crate::timestamp::from_json;

const URL: &str = "https://opencode.ai/zen/go/v1/usage";

/// Where an OpenCode Go key can be kept, and how its limits are read.
pub(super) const READER: Reader = Reader {
    sources: &[
        Source {
            app: "OpenCode",
            location: Location::File(OPENCODE),
            token: "/opencode-go/key",
            expires: None,
            plan: None,
        },
        Source {
            app: "Pi",
            location: Location::File(PI),
            token: "/opencode-go/key",
            expires: None,
            plan: None,
        },
    ],
    identity,
    fetch,
};

/// The account a key belongs to, as an FNV-1a hash of the key.
///
/// The hash is written out because account ids are kept across launches, and
/// the standard library's hasher may change between Rust releases.
fn identity(key: &str) -> Identity {
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    Identity {
        key: format!("{hash:016x}"),
        label: None,
    }
}

/// Ask for the limits of the plan a key belongs to.
fn fetch(key: &str, _identity: &Identity, _now: i64) -> Result<Usage, Problem> {
    super::get(URL, key, &[], parse)
}

/// The limits in a usage answer.
fn parse(body: &Value) -> Option<Usage> {
    let usage = &body["usage"];
    let limits = [
        ("rolling", "5 hours"),
        ("weekly", "Weekly"),
        ("monthly", "Monthly"),
    ]
    .into_iter()
    .filter_map(|(key, name)| {
        let window = &usage[key];
        super::limit(
            name.to_owned(),
            None,
            &window["percent"],
            from_json(&window["resetsAt"]),
        )
    })
    .collect();
    super::usage(Some("Go".to_owned()), limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rolling_weekly_and_monthly_limits_are_read() {
        let body = json!({"usage": {
            "rolling": {"status": "ok", "percent": 22, "resetsAt": "2026-09-03T05:00:00Z"},
            "weekly": {"status": "ok", "percent": 41.5, "resetsAt": "2026-09-07T00:00:00Z"},
            "monthly": {"status": "ok", "percent": 0, "resetsAt": "2026-10-01T00:00:00Z"}
        }});
        let usage = parse(&body).expect("reads");
        let names: Vec<&str> = usage
            .limits
            .iter()
            .map(|limit| limit.name.as_str())
            .collect();
        assert_eq!(names, ["5 hours", "Weekly", "Monthly"]);
        // A limit with nothing used is zero, not missing.
        assert_eq!(usage.limits[2].used_percent, 0.0);
        // Five hours after 2026-09-03T00:00:00Z, which is 1_788_393_600 seconds.
        assert_eq!(usage.limits[0].resets_at, Some(1_788_411_600_000));
        assert_eq!(usage.plan.as_deref(), Some("Go"));
    }

    #[test]
    fn a_key_is_its_own_account_without_being_kept() {
        // FNV-1a of "a" is the published test vector af63dc4c8601ec8c.
        assert_eq!(identity("a").key, "af63dc4c8601ec8c");
        assert_ne!(identity("key-one").key, identity("key-two").key);
    }
}
