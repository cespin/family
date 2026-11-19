//! Checks on single values. The rules that need the ledger live with their routes.

use std::collections::{BTreeMap, BTreeSet};

use family_core::{ApiError, Result};

use crate::rules::exact;

/// The largest whole number a browser reads exactly.
pub const MAX_PAYMENT_MINOR: i64 = 9_007_199_254_740_991;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_NOTE_CHARS: usize = 200;
const MAX_RATE_CHARS: usize = 20;
const MAX_RATE: i64 = 1_000_000;

pub fn invalid<T>(message: &str) -> Result<T> {
    Err(ApiError::validation(message))
}

/// A real calendar date written `YYYY-MM-DD`.
pub fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shaped {
        return false;
    }
    let (year, month, day): (u32, u32, u32) =
        match (text[..4].parse(), text[5..7].parse(), text[8..10].parse()) {
            (Ok(year), Ok(month), Ok(day)) => (year, month, day),
            _ => return false,
        };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

pub fn require_date(text: &str) -> Result<()> {
    if is_date(text) {
        Ok(())
    } else {
        invalid("The date is not a valid calendar date.")
    }
}

/// A UUID in its canonical lowercase form.
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

pub fn require_request_id(text: &str) -> Result<()> {
    if is_uuid(text) {
        Ok(())
    } else {
        invalid("The requestId is not a UUID.")
    }
}

/// Required after trimming spaces, and returns the trimmed text.
pub fn required_name(text: &str, what: &str) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError::validation(format!(
            "The {what} must have between 1 and {MAX_NAME_CHARS} characters."
        )));
    }
    Ok(trimmed.to_string())
}

/// A positive decimal within a sane range, kept as the text the member entered.
pub fn require_rate(text: &str) -> Result<()> {
    let value = (text.len() <= MAX_RATE_CHARS)
        .then(|| exact::decimal(text))
        .flatten();
    match value {
        Some(value) if value > exact::zero() && value <= exact::whole(MAX_RATE) => Ok(()),
        _ => invalid("An exchange rate must be a positive decimal number."),
    }
}

pub fn no_duplicates(ids: &[String], what: &str) -> Result<()> {
    if ids.iter().collect::<BTreeSet<_>>().len() == ids.len() {
        Ok(())
    } else {
        Err(ApiError::validation(format!("The {what} are repeated.")))
    }
}

/// Whole percentages for exactly these members, adding up to 100.
pub fn require_percentages(percents: &BTreeMap<String, i64>, member_ids: &[String]) -> Result<()> {
    let expected: BTreeSet<&String> = member_ids.iter().collect();
    if percents.keys().collect::<BTreeSet<_>>() != expected {
        return invalid("The percentages must name exactly the members they divide among.");
    }
    if percents
        .values()
        .any(|percent| !(0..=100).contains(percent))
    {
        return invalid("Each percentage must be between 0 and 100.");
    }
    if percents.values().sum::<i64>() != 100 {
        return invalid("The percentages must add up to 100.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case("2026-11-18", true)]
    #[case("2024-02-29", true)]
    #[case("2026-02-29", false)]
    #[case("2026-02-30", false)]
    #[case("2026-13-01", false)]
    #[case("2026-00-10", false)]
    #[case("2026-1-1", false)]
    #[case("18/11/2026", false)]
    fn recognises_real_dates(#[case] text: &str, #[case] expected: bool) {
        assert_eq!(is_date(text), expected);
    }

    #[rstest]
    #[case("90000000-0000-4000-8000-000000000001", true)]
    #[case("90000000-0000-4000-8000-00000000000A", false)]
    #[case("not-a-uuid", false)]
    fn recognises_canonical_uuids(#[case] text: &str, #[case] expected: bool) {
        assert_eq!(is_uuid(text), expected);
    }

    #[rstest]
    #[case("1.40", true)]
    #[case("670", true)]
    #[case("0", false)]
    #[case("-1.40", false)]
    #[case("mucho", false)]
    #[case("1000000.01", false)]
    fn recognises_usable_rates(#[case] text: &str, #[case] expected: bool) {
        assert_eq!(require_rate(text).is_ok(), expected);
    }
}
