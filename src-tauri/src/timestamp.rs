//! Instants, as Unix milliseconds.
//!
//! Every agent records times as RFC 3339 text or as a Unix number in seconds,
//! milliseconds, or microseconds. Both become `i64` milliseconds here, which is
//! the only time representation the rest of the engine and the frontend use.
//!
//! The parser is written out rather than taken from a datetime crate because
//! indexing parses one timestamp per session record and the shape is fixed:
//! `YYYY-MM-DDThh:mm:ss[.frac][Z|±hh:mm]`. Anything else is rejected.

/// Days in the months of a non-leap year, used to fold a date into a day count.
const MONTH_DAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// Parse RFC 3339 date-time text into Unix milliseconds.
///
/// Accepts a `Z` suffix or a numeric `±hh:mm` offset, and a fractional second
/// of any length (digits beyond milliseconds are truncated, not rounded, which
/// keeps a recorded instant from moving forward past a later one).
///
/// Returns `None` for text that is not a well-formed RFC 3339 instant, so a
/// malformed record loses its timestamp instead of the whole session.
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || (bytes[10] != b'T' && bytes[10] != b't' && bytes[10] != b' ') {
        return None;
    }
    let year = number(&bytes[0..4])?;
    let month = number(&bytes[5..7])?;
    let day = number(&bytes[8..10])?;
    let hour = number(&bytes[11..13])?;
    let minute = number(&bytes[14..16])?;
    let second = number(&bytes[17..19])?;
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = &bytes[19..];
    let mut fraction = 0i64;
    if rest.first() == Some(&b'.') || rest.first() == Some(&b',') {
        rest = &rest[1..];
        let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
        // Three digits is a millisecond; shorter values scale up, longer ones truncate.
        for position in 0..3 {
            let digit = rest.get(position).filter(|byte| byte.is_ascii_digit());
            fraction = fraction * 10 + digit.map_or(0, |byte| i64::from(byte - b'0'));
        }
        rest = &rest[digits..];
    }

    let offset_minutes = match rest.first() {
        None | Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            if rest.len() < 6 || rest[3] != b':' {
                return None;
            }
            let hours = number(&rest[1..3])?;
            let minutes = number(&rest[4..6])?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let magnitude = hours * 60 + minutes;
            if *sign == b'-' { -magnitude } else { magnitude }
        }
        Some(_) => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + fraction)
}

/// Normalize a Unix number whose unit the source does not state.
///
/// Agents write seconds, milliseconds, and microseconds in fields that are
/// otherwise identical. Magnitude separates them unambiguously for any instant
/// this application can meaningfully show: the ranges do not overlap until the
/// year 5138 in seconds.
pub fn from_unix_number(value: i64) -> Option<i64> {
    const YEAR_2001_SECONDS: i64 = 1_000_000_000;
    const YEAR_2001_MILLIS: i64 = YEAR_2001_SECONDS * 1_000;
    const YEAR_2001_MICROS: i64 = YEAR_2001_MILLIS * 1_000;
    match value {
        0 => None,
        value if value.abs() >= YEAR_2001_MICROS => Some(value / 1_000),
        value if value.abs() >= YEAR_2001_MILLIS => Some(value),
        value if value.abs() >= YEAR_2001_SECONDS => Some(value * 1_000),
        // Below the year 2001 in seconds the value is not an instant this
        // application records; treating it as one would date a session to 1970.
        _ => None,
    }
}

/// Read a JSON value that may hold either RFC 3339 text or a Unix number.
pub fn from_json(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::String(text) => parse_rfc3339(text),
        serde_json::Value::Number(number) => from_unix_number(number.as_f64()? as i64),
        _ => None,
    }
}

/// The current instant.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// How many days a month has, accounting for leap years.
///
/// Without this a date like `2100-02-29` would be accepted and silently become
/// the first of March, dating a session to a day it did not happen on.
fn days_in(year: i64, month: i64) -> i64 {
    let length = MONTH_DAYS[(month - 1) as usize];
    if month == 2 && is_leap(year) {
        29
    } else {
        length
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let mut days = (year - 1970) * 365 + leap_days(year);
    days += MONTH_DAYS.iter().take((month - 1) as usize).sum::<i64>();
    if month > 2 && is_leap(year) {
        days += 1;
    }
    days + day - 1
}

/// Leap days between 1970 and the start of `year`.
fn leap_days(year: i64) -> i64 {
    let before = year - 1;
    let count = |divisor: i64| before / divisor - 1969 / divisor;
    count(4) - count(100) + count(400)
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Read fixed-width ASCII digits as a number.
fn number(bytes: &[u8]) -> Option<i64> {
    let mut value = 0i64;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected values are taken from independent sources rather than from a
    /// round trip through this module: epoch arithmetic is the thing under
    /// test, so encoding with the same code would hide a matching pair of bugs.
    #[test]
    fn parses_instants_against_independently_known_values() {
        // 1970-01-01T00:00:00Z is the epoch by definition.
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        // 2001-09-09T01:46:40Z is the well-known 1_000_000_000 second mark.
        assert_eq!(
            parse_rfc3339("2001-09-09T01:46:40Z"),
            Some(1_000_000_000_000)
        );
        // 2026-09-03T07:20:02.227Z read from a real Codex rollout header.
        assert_eq!(
            parse_rfc3339("2026-09-03T07:20:02.227Z"),
            Some(1_788_420_002_227)
        );
    }

    #[test]
    fn applies_numeric_offsets() {
        let utc = parse_rfc3339("2026-09-03T07:20:02Z").expect("utc parses");
        // The same instant written in a zone five hours behind UTC.
        assert_eq!(parse_rfc3339("2026-09-03T02:20:02-05:00"), Some(utc));
        assert_eq!(parse_rfc3339("2026-09-03T09:20:02+02:00"), Some(utc));
    }

    #[test]
    fn handles_fractional_precision() {
        let base = parse_rfc3339("2026-09-03T07:20:02Z").expect("parses");
        assert_eq!(parse_rfc3339("2026-09-03T07:20:02.5Z"), Some(base + 500));
        assert_eq!(parse_rfc3339("2026-09-03T07:20:02.05Z"), Some(base + 50));
        // Microsecond text truncates to milliseconds rather than rounding up,
        // so a later record never sorts before an earlier one.
        assert_eq!(
            parse_rfc3339("2026-09-05T10:05:03.724981Z"),
            parse_rfc3339("2026-09-05T10:05:03.724Z")
        );
    }

    #[test]
    fn crosses_leap_days_correctly() {
        // 2024 is a leap year; 2100 is not, despite being divisible by four.
        let feb29 = parse_rfc3339("2024-02-29T00:00:00Z").expect("leap day parses");
        let mar01 = parse_rfc3339("2024-03-01T00:00:00Z").expect("parses");
        assert_eq!(mar01 - feb29, 86_400_000);
        assert_eq!(parse_rfc3339("2100-02-29T00:00:00Z"), None);
    }

    #[test]
    fn rejects_text_that_is_not_an_instant() {
        for malformed in [
            "",
            "not a time",
            "2026-09-03",
            "2026-13-01T00:00:00Z",
            "2026-09-03T24:00:00Z",
            "2026-09-03T07:20:02+0500",
            "2026/09/03T07:20:02Z",
        ] {
            assert_eq!(parse_rfc3339(malformed), None, "{malformed} should reject");
        }
    }

    #[test]
    fn separates_unix_units_by_magnitude() {
        let seconds = 1_788_420_002i64;
        assert_eq!(from_unix_number(seconds), Some(seconds * 1_000));
        assert_eq!(from_unix_number(seconds * 1_000), Some(seconds * 1_000));
        assert_eq!(from_unix_number(seconds * 1_000_000), Some(seconds * 1_000));
        assert_eq!(from_unix_number(0), None);
    }
}
