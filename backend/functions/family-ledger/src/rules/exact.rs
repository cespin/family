//! Exact fractions, so that no figure ever depends on floating point.

use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{One, ToPrimitive, Zero};

pub type Exact = BigRational;

pub fn whole(value: i64) -> Exact {
    Exact::from_integer(BigInt::from(value))
}

pub fn zero() -> Exact {
    Exact::zero()
}

pub fn one() -> Exact {
    Exact::one()
}

pub fn power_of_ten(digits: u32) -> Exact {
    Exact::from_integer(BigInt::from(10).pow(digits))
}

/// Rounds to a whole number. Halves go away from zero, so both sides of a debt mirror each other.
/// A figure too large for an `i64` saturates, and every caller then caps it at a real amount.
pub fn round(value: &Exact) -> i64 {
    let rounded = value.round().to_integer();
    rounded
        .to_i64()
        .unwrap_or(if rounded.sign() == num_bigint::Sign::Minus {
            i64::MIN
        } else {
            i64::MAX
        })
}

/// Reads a plain decimal such as `1.40`. Signs, exponents and blank parts are refused.
pub fn decimal(text: &str) -> Option<Exact> {
    let (integer, fraction) = text.split_once('.').unwrap_or((text, ""));
    let well_formed = !integer.is_empty()
        && integer.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && (!fraction.is_empty() || !text.contains('.'));
    if !well_formed {
        return None;
    }
    let digits: BigInt = format!("{integer}{fraction}").parse().ok()?;
    Some(Exact::from_integer(digits) / power_of_ten(fraction.len() as u32))
}

/// The stored form of a fraction, such as `141169/50`.
pub fn to_text(value: &Exact) -> String {
    format!("{}/{}", value.numer(), value.denom())
}

pub fn from_text(text: &str) -> Option<Exact> {
    let (numerator, denominator) = text.split_once('/')?;
    let denominator: BigInt = denominator.parse().ok()?;
    if denominator.is_zero() {
        return None;
    }
    Some(Exact::new(numerator.parse().ok()?, denominator))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(5, 2, 3)]
    #[case(-5, 2, -3)]
    #[case(7, 3, 2)]
    #[case(-7, 3, -2)]
    fn halves_round_away_from_zero(#[case] n: i64, #[case] d: i64, #[case] expected: i64) {
        assert_eq!(round(&(whole(n) / whole(d))), expected);
    }

    #[rstest]
    #[case("1.40", 7, 5)]
    #[case("670", 670, 1)]
    #[case("0.5", 1, 2)]
    fn reads_decimals_exactly(#[case] text: &str, #[case] n: i64, #[case] d: i64) {
        assert_eq!(decimal(text), Some(whole(n) / whole(d)));
    }

    #[rstest]
    #[case("")]
    #[case(".5")]
    #[case("5.")]
    #[case("-1.40")]
    #[case("+1")]
    #[case("1e3")]
    #[case("mucho")]
    #[case("1.2.3")]
    fn refuses_anything_but_a_plain_decimal(#[case] text: &str) {
        assert_eq!(decimal(text), None);
    }

    #[test]
    fn the_stored_form_survives_a_round_trip() {
        let value = whole(141169) / whole(50);
        assert_eq!(to_text(&value), "141169/50");
        assert_eq!(from_text("141169/50"), Some(value));
        assert_eq!(from_text("1/0"), None);
    }
}
