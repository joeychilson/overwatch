//! Subscription usage limits, read with the sign-ins already on this machine.
//!
//! A subscription is not an agent. One ChatGPT plan can be signed into from
//! Codex, OpenCode and Pi at once, so each subscription lists every place a
//! sign-in to it can be kept, groups the sign-ins it finds by the account they
//! belong to, and reads each account with whichever of its sign-ins works. A
//! person with no Codex installed but a ChatGPT plan connected to Pi still sees
//! its limits, and one account held by three apps is still one account.
//!
//! This is the application's only network traffic: a request to each
//! subscription's own usage endpoint. Sign-ins are only ever read. None is
//! renewed here, because renewing rotates the token an app holds and would
//! sign that app out; an expired sign-in waits for its app to renew it, and the
//! renewal is picked up within half a minute.
//!
//! Requests go through the system's `/usr/bin/curl` rather than an HTTP client
//! compiled into the application: a few small requests every few minutes do not
//! justify a TLS stack in the binary, and curl uses the macOS trust store. The
//! credential is written to curl's standard input, never its arguments, so it
//! does not appear in a process listing.

use std::cmp::Reverse;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

use crate::session::{Account, Limit, Problem, Provider};
use crate::timestamp::{from_json, from_unix_number};

mod claude;
mod codex;
mod grok;
mod opencode;
mod pace;

pub use pace::Alert;

/// How often an account's limits are read again while its sign-ins are
/// unchanged.
///
/// Limits move slowly next to history, and every read is a request to the
/// provider, some of which turn away frequent polling.
const REFRESH: Duration = Duration::from_mins(5);

/// How often sign-ins are looked for.
///
/// Looking is a few small file reads, cheap enough that a sign-in renewed or
/// added in another app shows within this long.
const LOOK: Duration = Duration::from_secs(30);

/// Where OpenCode keeps the subscriptions connected to it.
const OPENCODE: &str = ".local/share/opencode/auth.json";

/// Where Pi keeps the subscriptions connected to it.
const PI: &str = ".pi/agent/auth.json";

/// How one subscription is read.
struct Reader {
    /// Every place a sign-in to it can be kept.
    sources: &'static [Source],
    /// The account a token belongs to.
    identity: fn(&str) -> Identity,
    /// Ask the provider for an account's limits with one of its tokens.
    fetch: fn(&str, &Identity, i64) -> Result<Usage, Problem>,
}

/// One place an app keeps a sign-in to a subscription.
struct Source {
    /// The app, as the interface names it.
    app: &'static str,
    /// Where the app keeps it.
    location: Location,
    /// JSON pointer to the token.
    token: &'static str,
    /// JSON pointer to when the token expires, where the app records it.
    expires: Option<&'static str>,
    /// JSON pointer to the plan, where the app records it.
    plan: Option<&'static str>,
}

/// Where an app keeps a sign-in.
enum Location {
    /// A JSON file, relative to the home directory.
    File(&'static str),
    /// A login Keychain password whose value is JSON.
    Keychain(&'static str),
}

/// A sign-in found on this machine.
struct SignIn {
    app: &'static str,
    token: String,
    expires: Option<i64>,
    plan: Option<String>,
}

/// The account a token belongs to.
struct Identity {
    /// The same for every token to the account; empty when tokens do not say.
    key: String,
    /// What tells the account apart from others of the same subscription.
    label: Option<String>,
}

/// What a provider reported for one account.
struct Usage {
    plan: Option<String>,
    limits: Vec<Limit>,
}

/// Keep one subscription's accounts current for as long as the app runs.
///
/// Sign-ins are looked for every [`LOOK`]. The provider is asked only when they
/// change — one added, renewed or removed — or when [`REFRESH`] has passed.
/// After each read, `record` is given every account, its limits forecast, and
/// the alerts the read gave rise to.
pub fn watch(provider: Provider, home: &Path, mut record: impl FnMut(Vec<Account>, Vec<Alert>)) {
    let reader = reader(provider);
    let mut pace = pace::Pace::default();
    let mut last: Option<(u64, Instant)> = None;
    loop {
        let sign_ins = find(&reader, home);
        let fingerprint = fingerprint(&sign_ins);
        if last.is_none_or(|(seen, at)| seen != fingerprint || at.elapsed() >= REFRESH) {
            let now = crate::timestamp::now();
            let mut accounts = read(provider, &reader, sign_ins, now);
            let alerts = pace.update(&mut accounts, now);
            record(accounts, alerts);
            last = Some((fingerprint, Instant::now()));
        }
        std::thread::sleep(LOOK);
    }
}

/// How a subscription is read.
fn reader(provider: Provider) -> Reader {
    match provider {
        Provider::Claude => claude::READER,
        Provider::Codex => codex::READER,
        Provider::Grok => grok::READER,
        Provider::OpenCodeGo => opencode::READER,
    }
}

/// Every sign-in to a subscription on this machine.
fn find(reader: &Reader, home: &Path) -> Vec<SignIn> {
    reader
        .sources
        .iter()
        .filter_map(|source| {
            let kept: Value = match source.location {
                Location::File(path) => {
                    serde_json::from_slice(&std::fs::read(home.join(path)).ok()?).ok()?
                }
                Location::Keychain(service) => keychain(service)?,
            };
            let token = kept.pointer(source.token)?.as_str()?.to_owned();
            let expires = source
                .expires
                .and_then(|pointer| kept.pointer(pointer))
                .and_then(from_json)
                // An app that records no expiry still holds a token that says.
                .or_else(|| claims(&token)["exp"].as_i64().and_then(from_unix_number));
            let plan = source
                .plan
                .and_then(|pointer| kept.pointer(pointer))
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(SignIn {
                app: source.app,
                token,
                expires,
                plan,
            })
        })
        .collect()
}

/// A login Keychain password's JSON value.
///
/// Read with `/usr/bin/security`, the tool Claude Code writes its sign-in with,
/// so the item already trusts the reader and no permission prompt appears.
fn keychain(service: &str) -> Option<Value> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// What changes when a sign-in is added, renewed or removed.
fn fingerprint(sign_ins: &[SignIn]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for sign_in in sign_ins {
        sign_in.token.hash(&mut hasher);
    }
    hasher.finish()
}

/// Read every account the sign-ins belong to.
///
/// An account's sign-ins are tried freshest first, and one known to have
/// expired is never sent. A sign-in the provider refuses gives way to the next;
/// any other failure is the account's answer.
fn read(provider: Provider, reader: &Reader, sign_ins: Vec<SignIn>, now: i64) -> Vec<Account> {
    let mut accounts: Vec<(Identity, Vec<SignIn>)> = Vec::new();
    for sign_in in sign_ins {
        let identity = (reader.identity)(&sign_in.token);
        match accounts
            .iter_mut()
            .find(|(known, _)| known.key == identity.key)
        {
            Some((known, held)) => {
                known.label = known.label.take().or(identity.label);
                held.push(sign_in);
            }
            None => accounts.push((identity, vec![sign_in])),
        }
    }
    accounts
        .into_iter()
        .map(|(identity, mut held)| {
            held.sort_by_key(|sign_in| Reverse(sign_in.expires));
            let mut result = Err(Problem::SignIn);
            for sign_in in held
                .iter()
                .filter(|sign_in| sign_in.expires.is_none_or(|at| at > now))
            {
                result = (reader.fetch)(&sign_in.token, &identity, now);
                if !matches!(result, Err(Problem::SignIn)) {
                    break;
                }
            }
            let (limits, plan, read_at, problem) = match result {
                Ok(usage) => (usage.limits, usage.plan, Some(now), None),
                Err(problem) => (Vec::new(), None, None, Some(problem)),
            };
            Account {
                id: format!("{}:{}", provider.key(), identity.key),
                provider,
                label: identity.label,
                plan: plan.or_else(|| held.iter().find_map(|sign_in| sign_in.plan.clone())),
                via: held.iter().map(|sign_in| sign_in.app.to_owned()).collect(),
                limits,
                read_at,
                problem,
                used_at: None,
            }
        })
        .collect()
}

/// The claims a token carries, or null when it is not a JWT.
///
/// Read without checking the signature: claims only group sign-ins and label
/// accounts, and the provider checks the token itself.
fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload).ok())
        .and_then(|json| serde_json::from_slice(&json).ok())
        .unwrap_or(Value::Null)
}

/// Request a provider's usage and read its limits out of the answer.
///
/// `headers` go to the provider as written, the credential among them.
fn get(
    url: &str,
    headers: &[String],
    parse: impl FnOnce(&Value) -> Option<Usage>,
) -> Result<Usage, Problem> {
    // A line break inside a header would let a malformed sign-in add headers
    // of its own to the request.
    if headers.iter().any(|header| header.contains(['\r', '\n'])) {
        return Err(Problem::SignIn);
    }
    let mut curl = Command::new("/usr/bin/curl")
        .args([
            // Must come first. It keeps a `~/.curlrc` from adding options, such
            // as a trace file, that would record the credential.
            "--disable",
            "--silent",
            "--proto",
            "=https",
            "--max-time",
            "20",
            "--max-filesize",
            "1048576",
            "--header",
            "@-",
            // The status goes to standard error so the body arrives intact.
            "--write-out",
            "%{stderr}%{http_code}",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Problem::Unavailable)?;
    let agent = if headers
        .iter()
        .any(|header| header.starts_with("User-Agent:"))
    {
        ""
    } else {
        "User-Agent: Overwatch\n"
    };
    let request = format!("Accept: application/json\n{agent}{}\n", headers.join("\n"));
    let sent = curl
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(request.as_bytes()).is_ok());
    let output = curl.wait_with_output().map_err(|_| Problem::Unavailable)?;
    let status = std::str::from_utf8(&output.stderr)
        .ok()
        .and_then(|text| text.trim().parse().ok());
    match status {
        Some(status) if sent && output.status.success() => {
            parse(&answer(status, &output.stdout)?).ok_or(Problem::Unrecognized)
        }
        _ => Err(Problem::Unavailable),
    }
}

/// What a provider's HTTP answer means.
fn answer(status: u16, body: &[u8]) -> Result<Value, Problem> {
    match status {
        200..=299 => serde_json::from_slice(body).map_err(|_| Problem::Unrecognized),
        401 | 403 => Err(Problem::SignIn),
        408 | 429 | 500..=599 => Err(Problem::Unavailable),
        _ => Err(Problem::Unrecognized),
    }
}

/// What a provider reported, or nothing when the answer held no limit this
/// version understands.
fn usage(plan: Option<String>, limits: Vec<Limit>) -> Option<Usage> {
    (!limits.is_empty()).then_some(Usage { plan, limits })
}

/// A usage percentage, or nothing when the value is not one.
///
/// Above 100 is kept: providers report it once a limit is exceeded.
fn percent(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|percent| percent.is_finite() && *percent >= 0.0)
}

/// A window's length, said the way a person would say it.
fn span(seconds: i64) -> String {
    const HOUR: i64 = 3_600;
    const DAY: i64 = 24 * HOUR;
    if seconds < 23 * HOUR {
        let hours = ((seconds + HOUR / 2) / HOUR).max(1);
        return if hours == 1 {
            "Hourly".to_owned()
        } else {
            format!("{hours} hours")
        };
    }
    // Rounded to whole days, because a period that crosses a clock change is
    // an hour long or short.
    match (seconds + DAY / 2) / DAY {
        1 => "Daily".to_owned(),
        7 => "Weekly".to_owned(),
        28..=31 => "Monthly".to_owned(),
        days => format!("{days} days"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Tokens here are `account:outcome`, so a test says whose a sign-in is and
    /// what the provider makes of it without touching the network.
    fn fake_identity(token: &str) -> Identity {
        Identity {
            key: token.split(':').next().unwrap_or_default().to_owned(),
            label: None,
        }
    }

    fn fake_fetch(token: &str, _: &Identity, _: i64) -> Result<Usage, Problem> {
        if token.ends_with(":good") {
            Ok(Usage {
                plan: Some("pro".into()),
                limits: Vec::new(),
            })
        } else {
            Err(Problem::SignIn)
        }
    }

    const FAKE: Reader = Reader {
        sources: &[],
        identity: fake_identity,
        fetch: fake_fetch,
    };

    fn sign_in(app: &'static str, token: &str, expires: Option<i64>) -> SignIn {
        SignIn {
            app,
            token: token.into(),
            expires,
            plan: None,
        }
    }

    #[test]
    fn each_account_is_read_once_with_its_freshest_working_sign_in() {
        let now = 1_000_000;
        let accounts = read(
            Provider::Codex,
            &FAKE,
            vec![
                // Would work, but has expired, so it is never sent.
                sign_in("Codex", "a:expired:good", Some(now - 1)),
                // The freshest, but refused, so it gives way to the next.
                sign_in("Pi", "a:refused", Some(now + 2_000)),
                sign_in("OpenCode", "a:good", Some(now + 1_000)),
                sign_in("Pi", "b:refused", None),
            ],
            now,
        );
        assert_eq!(accounts.len(), 2, "one per account, however many apps");

        assert_eq!(accounts[0].id, "codex:a");
        assert_eq!(accounts[0].read_at, Some(now));
        assert_eq!(accounts[0].plan.as_deref(), Some("pro"));
        assert_eq!(accounts[0].via, ["Pi", "OpenCode", "Codex"]);

        assert_eq!(accounts[1].id, "codex:b");
        assert_eq!(accounts[1].problem, Some(Problem::SignIn));
        assert_eq!(accounts[1].read_at, None);
    }

    #[test]
    fn claims_are_read_from_a_jwt_and_nothing_else() {
        // The payload is `{"sub":"abc"}` in unpadded base64url.
        assert_eq!(claims("header.eyJzdWIiOiJhYmMifQ.signature")["sub"], "abc");
        assert_eq!(claims("an-api-key"), Value::Null);
    }

    #[test]
    fn an_answer_becomes_a_problem_only_when_it_is_one() {
        assert_eq!(answer(200, br#"{"ok":true}"#), Ok(json!({"ok": true})));
        assert_eq!(answer(200, b"<html>"), Err(Problem::Unrecognized));
        // A refused sign-in needs its app; a busy or failing provider needs
        // only time.
        assert_eq!(answer(401, b""), Err(Problem::SignIn));
        assert_eq!(answer(403, b""), Err(Problem::SignIn));
        assert_eq!(answer(429, b""), Err(Problem::Unavailable));
        assert_eq!(answer(503, b""), Err(Problem::Unavailable));
        assert_eq!(answer(404, b""), Err(Problem::Unrecognized));
    }

    #[test]
    fn windows_are_named_for_their_length() {
        assert_eq!(span(5 * 3_600), "5 hours");
        assert_eq!(span(3_600), "Hourly");
        assert_eq!(span(86_400), "Daily");
        assert_eq!(span(7 * 86_400), "Weekly");
        assert_eq!(span(7 * 86_400 - 3_600), "Weekly");
        assert_eq!(span(30 * 86_400), "Monthly");
        assert_eq!(span(3 * 86_400), "3 days");
    }

    #[test]
    fn a_percentage_must_be_a_real_nonnegative_number() {
        assert_eq!(percent(&json!(42)), Some(42.0));
        assert_eq!(percent(&json!(104.5)), Some(104.5));
        assert_eq!(percent(&json!(-1)), None);
        assert_eq!(percent(&json!("42")), None);
        assert_eq!(percent(&Value::Null), None);
    }
}
