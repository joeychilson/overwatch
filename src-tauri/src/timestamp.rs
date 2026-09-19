//! Instants, as Unix milliseconds.
//!
//! Every agent records times as RFC 3339 text or as a Unix number in seconds,
//! milliseconds, or microseconds. Both become `i64` milliseconds here, the
//! only time representation the rest of the engine and the frontend use.
//!
//! The parser is written out rather than taken from a datetime crate because
//! indexing parses a timestamp per record and the shape is fixed:
//! `YYYY-MM-DDThh:mm:ss[.frac][Z|±hh:mm]`. Anything else is rejected.

/// Days in the months of a non-leap year, used to fold a date into a day count.
const MONTH_DAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// Parse RFC 3339 date-time text into Unix milliseconds.
///
/// Accepts a `Z` suffix, a numeric `±hh:mm` offset, or neither for UTC, and a
/// fractional second of any length. Digits beyond milliseconds are truncated,
/// not rounded, which keeps an instant from moving past a later one.
///
/// Returns `None` for text that is not a well-formed instant, so a malformed
/// record loses its timestamp instead of the whole session.
pub(crate) fn parse_rfc3339(text: &str) -> Option<i64> {
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
    let mut millis = 0;
    if let [b'.' | b',', fraction @ ..] = rest {
        let digits = fraction
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0 {
            return None;
        }
        // The first three digits are milliseconds, padded when there are fewer.
        millis = fraction[..digits]
            .iter()
            .chain(b"00")
            .take(3)
            .fold(0, |millis, digit| millis * 10 + i64::from(digit - b'0'));
        rest = &fraction[digits..];
    }

    let offset_minutes = match *rest {
        [] | [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), h0, h1, b':', m0, m1] => {
            let (hours, minutes) = (number(&[h0, h1])?, number(&[m0, m1])?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            let magnitude = hours * 60 + minutes;
            if sign == b'-' { -magnitude } else { magnitude }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Normalize a Unix number whose unit the source does not state.
///
/// Agents write seconds, milliseconds, and microseconds in fields that are
/// otherwise identical. Magnitude separates them unambiguously for any instant
/// this application can meaningfully show: the ranges do not overlap until the
/// year 5138 in seconds.
///
/// Returns `None` for anything before 2001 in seconds, which is not an instant
/// an agent recorded; treating it as one would date a session to 1970.
pub(crate) fn from_unix_number(value: i64) -> Option<i64> {
    const YEAR_2001_SECONDS: i64 = 1_000_000_000;
    const YEAR_2001_MILLIS: i64 = YEAR_2001_SECONDS * 1_000;
    const YEAR_2001_MICROS: i64 = YEAR_2001_MILLIS * 1_000;
    match value {
        YEAR_2001_MICROS.. => Some(value / 1_000),
        YEAR_2001_MILLIS.. => Some(value),
        YEAR_2001_SECONDS.. => Some(value * 1_000),
        _ => None,
    }
}

/// Read a JSON value that may hold either RFC 3339 text or a Unix number.
pub(crate) fn from_json(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::String(text) => parse_rfc3339(text),
        serde_json::Value::Number(number) => from_unix_number(number.as_f64()? as i64),
        _ => None,
    }
}

/// The current instant.
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// The same moment a calendar month before `at`, in universal time: the same
/// day of the previous month, or its last day when it is shorter, as a
/// subscription billed on the 31st renews on the 28th in February.
///
/// Returns `None` for an instant too far from 1970 to count back from.
pub(crate) fn month_before(at: i64) -> Option<i64> {
    const DAY: i64 = 86_400_000;
    let (days, into_day) = (at.div_euclid(DAY), at.rem_euclid(DAY));
    let (year, month, day) = civil_from_days(days)?;
    let (year, month) = if month == 1 {
        (year.checked_sub(1)?, 12)
    } else {
        (year, month - 1)
    };
    days_from_civil(year, month, day.min(days_in(year, month)))
        .checked_mul(DAY)?
        .checked_add(into_day)
}

/// The proleptic Gregorian date of a day counted from 1970-01-01, by Howard
/// Hinnant's `civil_from_days`, counting in eras of 400 years from 0000-03-01.
fn civil_from_days(days: i64) -> Option<(i64, i64, i64)> {
    let shifted = days.checked_add(719_468)?;
    let era = shifted.div_euclid(146_097);
    let of_era = shifted.rem_euclid(146_097);
    let year_of_era = (of_era - of_era / 1_460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = era.checked_mul(400)?.checked_add(year_of_era)?;
    Some((if month <= 2 { year + 1 } else { year }, month, day))
}

/// How many days a month has, accounting for leap years, so that a date such
/// as `2100-02-29` is rejected rather than read as the first of March.
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

/// Whether a year of the proleptic Gregorian calendar has a 29th of February.
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
        assert_eq!(
            parse_rfc3339("2026-09-03T07:20:02"),
            Some(base),
            "no zone is UTC"
        );
        assert_eq!(parse_rfc3339("2026-09-03T07:20:02.5Z"), Some(base + 500));
        assert_eq!(parse_rfc3339("2026-09-03T07:20:02,05Z"), Some(base + 50));
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
            "2026-09-03T07:20:02.Z",
            "2026-09-03T07:20:02Zulu",
            "2026-09-03T07:20:02+05:00:00",
            "2026-09-03T07:20:02.5+05",
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
        // Nothing before 2001 is an instant an agent recorded, and taking the
        // magnitude of the most negative number would overflow.
        for before in [0, 999_999_999, -seconds, i64::MIN] {
            assert_eq!(from_unix_number(before), None, "{before}");
        }
        assert_eq!(from_json(&serde_json::json!(-1.0e30)), None);
    }

    #[test]
    fn a_month_before_is_the_same_day_or_the_shorter_months_last() {
        let at = |text| parse_rfc3339(text).expect("parses");
        assert_eq!(
            month_before(at("2026-10-01T00:00:00Z")),
            Some(at("2026-09-01T00:00:00Z"))
        );
        assert_eq!(
            month_before(at("2026-01-15T05:06:07.890Z")),
            Some(at("2025-12-15T05:06:07.890Z"))
        );
        assert_eq!(
            month_before(at("2026-03-31T12:00:00Z")),
            Some(at("2026-02-28T12:00:00Z"))
        );
        assert_eq!(
            month_before(at("2028-03-30T00:00:00Z")),
            Some(at("2028-02-29T00:00:00Z"))
        );
        // Before the epoch counts back the same way.
        assert_eq!(
            month_before(at("1969-03-01T00:00:00Z")),
            Some(at("1969-02-01T00:00:00Z"))
        );
    }

    #[test]
    fn days_are_dated_against_independently_known_dates() {
        assert_eq!(civil_from_days(0), Some((1970, 1, 1)));
        // 2000-03-01 is day 11,017, the first after a leap day in a year
        // divisible by 400.
        assert_eq!(civil_from_days(11_017), Some((2000, 3, 1)));
        assert_eq!(civil_from_days(11_016), Some((2000, 2, 29)));
        // 2024-01-01 is day 19,723.
        assert_eq!(civil_from_days(19_723), Some((2024, 1, 1)));
        assert_eq!(civil_from_days(-1), Some((1969, 12, 31)));
    }
}
