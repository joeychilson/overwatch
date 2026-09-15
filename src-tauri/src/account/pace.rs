//! When a limit will run out at the current rate of use, and when a change in a
//! limit is worth a notification.
//!
//! The rate comes from the readings this process takes, not from local session
//! files: providers count usage from every device and from their own apps, and
//! their percentages cannot be rebuilt from token counts.

use std::collections::HashMap;

use crate::session::Account;

/// How far back readings count toward a rate.
///
/// Long enough to see past a pause between prompts, short enough to follow a
/// change of pace within a session.
const SPAN: i64 = 60 * 60_000;

/// The shortest run of readings a rate is taken from.
///
/// Providers report whole percents, so over a shorter run one step of rounding
/// reads as a steep rate.
const LEAST: i64 = 15 * 60_000;

/// How far ahead running out is worth a notification.
const HORIZON: i64 = 24 * 60 * 60_000;

/// A notification worth showing.
#[derive(Debug, PartialEq, Eq)]
pub struct Alert {
    /// The subscription, and the account when it has a label.
    pub title: String,
    /// What happened, to which limit.
    pub body: String,
}

/// What has been said about a limit in its current window.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Said {
    Nothing,
    RunningOut,
    Reached,
}

/// One limit's recent readings, and what has been said about it.
struct Tracked {
    readings: Vec<(i64, f64)>,
    said: Said,
}

/// Forecasts and alerts for one subscription's accounts, kept across reads.
#[derive(Default)]
pub struct Pace {
    limits: HashMap<String, Tracked>,
}

impl Pace {
    /// Take in a read: forecast every limit read now, and return the changes
    /// worth a notification.
    ///
    /// A limit's first reading only records its state, so relaunching the app
    /// does not repeat what was already said.
    pub fn update(&mut self, accounts: &mut [Account], now: i64) -> Vec<Alert> {
        let mut alerts = Vec::new();
        for account in accounts
            .iter_mut()
            .filter(|account| account.read_at == Some(now))
        {
            let name = account.provider.name();
            let title = account
                .label
                .as_ref()
                .map_or_else(|| name.to_owned(), |label| format!("{name} · {label}"));
            for limit in &mut account.limits {
                let key = format!(
                    "{}|{}|{}",
                    account.id,
                    limit.scope.as_deref().unwrap_or_default(),
                    limit.name
                );
                let seen = self.limits.contains_key(&key);
                let tracked = self.limits.entry(key).or_insert(Tracked {
                    readings: Vec::new(),
                    said: Said::Nothing,
                });
                // Usage going down means the window reset or rolled on, so the
                // earlier readings no longer describe it.
                if tracked
                    .readings
                    .last()
                    .is_some_and(|&(_, used)| limit.used_percent < used)
                {
                    tracked.readings.clear();
                    if tracked.said == Said::RunningOut {
                        tracked.said = Said::Nothing;
                    }
                }
                tracked.readings.retain(|&(at, _)| now - at <= SPAN);
                tracked.readings.push((now, limit.used_percent));
                limit.runs_out_at = forecast(&tracked.readings, limit.resets_at);

                // Using up one model's limit does not stop work, so it is not
                // worth interrupting anyone for.
                if limit.scope.is_some() {
                    continue;
                }
                let reached = limit.used_percent >= 100.0;
                let (said, body) = match (tracked.said, reached, limit.runs_out_at, limit.resets_at)
                {
                    (Said::Reached, true, _, _) => (Said::Reached, None),
                    (_, true, _, Some(resets_at)) => (
                        Said::Reached,
                        Some(format!(
                            "{}: limit reached. Back in {}.",
                            limit.name,
                            duration(resets_at - now)
                        )),
                    ),
                    (_, true, _, None) => (
                        Said::Reached,
                        Some(format!("{}: limit reached.", limit.name)),
                    ),
                    (Said::Reached, false, _, _) => (
                        Said::Nothing,
                        Some(format!("{}: available again.", limit.name)),
                    ),
                    (Said::Nothing, false, Some(runs_out_at), Some(resets_at))
                        if runs_out_at - now <= HORIZON =>
                    {
                        (
                            Said::RunningOut,
                            Some(format!(
                                "{}: at this pace, runs out in about {}. It resets in {}.",
                                limit.name,
                                duration(runs_out_at - now),
                                duration(resets_at - now)
                            )),
                        )
                    }
                    (said, false, _, _) => (said, None),
                };
                tracked.said = said;
                if let Some(body) = body.filter(|_| seen) {
                    alerts.push(Alert {
                        title: title.clone(),
                        body,
                    });
                }
            }
        }
        alerts
    }
}

/// When a limit runs out at the rate its readings rose, if that is before it
/// resets.
fn forecast(readings: &[(i64, f64)], resets_at: Option<i64>) -> Option<i64> {
    let (&(from, first), &(now, used)) = (readings.first()?, readings.last()?);
    if now - from < LEAST || used <= first || used >= 100.0 {
        return None;
    }
    let rate = (used - first) / (now - from) as f64;
    // Saturating: a slow enough rate puts running out past any instant.
    let runs_out_at = now.saturating_add(((100.0 - used) / rate) as i64);
    resets_at
        .filter(|resets_at| runs_out_at < *resets_at)
        .map(|_| runs_out_at)
}

/// A span of time as a person would say it: `40m`, `2h 10m` or `3d 4h`.
fn duration(milliseconds: i64) -> String {
    let minutes = (milliseconds / 60_000).max(1);
    let (days, hours) = (minutes / 1_440, minutes / 60);
    if days > 0 {
        format!("{days}d {}h", hours % 24)
    } else if hours > 0 {
        format!("{hours}h {}m", minutes % 60)
    } else {
        format!("{minutes}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Limit, Provider};

    const MINUTE: i64 = 60_000;

    /// Read a five-hour limit at `used` percent, `minute` minutes in, and
    /// return its forecast and what was said.
    fn read(pace: &mut Pace, minute: i64, used: f64, resets_at: i64) -> (Option<i64>, Vec<String>) {
        let now = minute * MINUTE;
        let mut accounts = vec![Account {
            id: "codex:a".into(),
            provider: Provider::Codex,
            label: None,
            plan: None,
            via: vec!["Codex".into()],
            limits: vec![Limit {
                name: "5 hours".into(),
                scope: None,
                used_percent: used,
                resets_at: Some(resets_at),
                runs_out_at: None,
            }],
            read_at: Some(now),
            problem: None,
            used_at: None,
        }];
        let alerts = pace.update(&mut accounts, now);
        let bodies = alerts.into_iter().map(|alert| alert.body).collect();
        (accounts[0].limits[0].runs_out_at, bodies)
    }

    #[test]
    fn a_limit_runs_out_at_the_rate_its_readings_rose() {
        let reset = 300 * MINUTE;
        let mut pace = Pace::default();
        assert_eq!(read(&mut pace, 0, 40.0, reset).0, None, "no rate yet");
        assert_eq!(read(&mut pace, 10, 45.0, reset).0, None, "too short a run");
        // Ten points in twenty minutes leaves fifty points for another hundred.
        assert_eq!(read(&mut pace, 20, 50.0, reset).0, Some(120 * MINUTE));

        // The same rate against a reset due sooner outlasts the window.
        let mut sooner = Pace::default();
        read(&mut sooner, 0, 40.0, 100 * MINUTE);
        assert_eq!(read(&mut sooner, 20, 50.0, 100 * MINUTE).0, None);

        // No rise, no rate.
        let mut idle = Pace::default();
        read(&mut idle, 0, 40.0, reset);
        assert_eq!(read(&mut idle, 30, 40.0, reset).0, None);
    }

    #[test]
    fn each_change_is_said_once() {
        let reset = 300 * MINUTE;
        let mut pace = Pace::default();
        assert!(read(&mut pace, 0, 40.0, reset).1.is_empty());
        // Thirty points in twenty minutes: the last thirty take twenty more.
        assert_eq!(
            read(&mut pace, 20, 70.0, reset).1,
            ["5 hours: at this pace, runs out in about 20m. It resets in 4h 40m."]
        );
        assert!(
            read(&mut pace, 25, 80.0, reset).1.is_empty(),
            "once a window"
        );
        assert_eq!(
            read(&mut pace, 30, 100.0, reset).1,
            ["5 hours: limit reached. Back in 4h 30m."]
        );
        assert!(read(&mut pace, 35, 100.0, reset).1.is_empty());
        // The window resets, usage falls, and the limit is back.
        assert_eq!(
            read(&mut pace, 305, 0.0, 600 * MINUTE).1,
            ["5 hours: available again."]
        );
    }

    #[test]
    fn a_limit_reached_before_launch_is_not_announced_but_its_return_is() {
        let mut pace = Pace::default();
        assert!(read(&mut pace, 0, 100.0, 60 * MINUTE).1.is_empty());
        assert_eq!(
            read(&mut pace, 65, 5.0, 360 * MINUTE).1,
            ["5 hours: available again."]
        );
    }

    #[test]
    fn spans_are_said_in_the_largest_units_that_fit() {
        assert_eq!(duration(40 * MINUTE), "40m");
        assert_eq!(duration(130 * MINUTE), "2h 10m");
        assert_eq!(duration((3 * 24 + 4) * 60 * MINUTE), "3d 4h");
        assert_eq!(duration(10_000), "1m", "under a minute still reads as one");
    }
}
