//! Turning what the public rate services answered into the family's two rates. No I/O here.
//!
//! Each service quotes 1 USD in CAD and in CLP. The CAD to CLP rate is derived from those two, and
//! each pair is combined on its own: the middle of three values, or the average of two that agree.

use family_core::{ApiError, Result};

use crate::rules::exact::{self, Exact};
use crate::rules::validate::require_rate;

/// Decimals kept for 1 USD in CAD, such as `1.4328`.
pub const USD_CAD_PLACES: u32 = 4;
/// Decimals kept for 1 CAD in CLP, such as `711.42`.
pub const CAD_CLP_PLACES: u32 = 2;

/// What one service answered, as exact decimals.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub source: String,
    pub usd_cad: Exact,
    pub usd_clp: Exact,
}

/// The rates to store, as the decimal text the ledger keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combined {
    pub usd_cad: String,
    pub cad_clp: String,
}

/// How far apart two answers may be, as a fraction, when the third service did not answer.
fn agreement() -> Exact {
    exact::whole(1) / exact::whole(100)
}

fn usable(value: &Exact, places: u32) -> bool {
    require_rate(&exact::to_decimal(value, places)).is_ok()
}

/// One pair: the middle of three values, or the average of two within 1% of each other.
fn combine_pair(mut values: Vec<Exact>, what: &str) -> Result<Exact> {
    values.sort();
    match values.as_slice() {
        [_, middle, _] => Ok(middle.clone()),
        [low, high] => {
            if (high / low - exact::one()) <= agreement() {
                Ok((low + high) / exact::whole(2))
            } else {
                Err(ApiError::rates_unavailable(format!(
                    "the two {what} rates that answered differ by more than 1%"
                )))
            }
        }
        _ => Err(ApiError::rates_unavailable(format!(
            "only {} {what} rate(s) answered, and at least two are needed",
            values.len()
        ))),
    }
}

/// Combines the services' answers. Failed answers, and values outside what a rate may be, are left
/// out first. More than three answers is a programming error.
pub fn combine(answers: &[Result<Quote>]) -> Result<Combined> {
    let quotes: Vec<&Quote> = answers
        .iter()
        .filter_map(|answer| answer.as_ref().ok())
        .collect();
    if quotes.len() > 3 {
        return Err(ApiError::internal(
            "more than three rate services were asked",
        ));
    }
    let usd_cad: Vec<Exact> = quotes
        .iter()
        .map(|quote| quote.usd_cad.clone())
        .filter(|value| usable(value, USD_CAD_PLACES))
        .collect();
    let cad_clp: Vec<Exact> = quotes
        .iter()
        .filter(|quote| quote.usd_cad > exact::zero())
        .map(|quote| &quote.usd_clp / &quote.usd_cad)
        .filter(|value| usable(value, CAD_CLP_PLACES))
        .collect();
    Ok(Combined {
        usd_cad: exact::to_decimal(&combine_pair(usd_cad, "USD to CAD")?, USD_CAD_PLACES),
        cad_clp: exact::to_decimal(&combine_pair(cad_clp, "CAD to CLP")?, CAD_CLP_PLACES),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(text: &str) -> Exact {
        exact::decimal(text).unwrap()
    }

    /// A quote whose CAD to CLP rate is exactly `cad_clp`.
    fn quote(usd_cad: &str, cad_clp: &str) -> Result<Quote> {
        Ok(Quote {
            source: "test".to_string(),
            usd_cad: decimal(usd_cad),
            usd_clp: decimal(usd_cad) * decimal(cad_clp),
        })
    }

    fn failed() -> Result<Quote> {
        Err(ApiError::rates_unavailable("timed out"))
    }

    #[test]
    fn three_answers_give_the_middle_one() {
        let combined = combine(&[
            quote("1.145", "700"),
            quote("1.201", "710"),
            quote("1.173", "705"),
        ])
        .unwrap();
        assert_eq!(combined.usd_cad, "1.1730");
        assert_eq!(combined.cad_clp, "705.00");
    }

    #[test]
    fn each_pair_takes_its_own_middle() {
        let combined = combine(&[
            quote("1.40", "720"),
            quote("1.42", "700"),
            quote("1.41", "710"),
        ])
        .unwrap();
        assert_eq!(combined.usd_cad, "1.4100");
        assert_eq!(combined.cad_clp, "710.00");
    }

    #[test]
    fn cad_to_clp_is_derived_from_the_dollar_quotes() {
        let derived = Quote {
            source: "test".to_string(),
            usd_cad: decimal("1.4328"),
            usd_clp: decimal("1019.32"),
        };
        let combined = combine(&[Ok(derived.clone()), Ok(derived.clone()), Ok(derived)]).unwrap();
        // 1019.32 / 1.4328 = 711.418...
        assert_eq!(combined.cad_clp, "711.42");
    }

    #[test]
    fn two_answers_that_agree_give_their_average() {
        let combined = combine(&[quote("1.40", "700"), failed(), quote("1.41", "705")]).unwrap();
        assert_eq!(combined.usd_cad, "1.4050");
        assert_eq!(combined.cad_clp, "702.50");
    }

    #[test]
    fn two_answers_that_disagree_are_refused() {
        let error = combine(&[quote("1.40", "700"), quote("1.50", "700"), failed()]).unwrap_err();
        assert_eq!(error.code(), "rates_unavailable");
    }

    #[test]
    fn one_answer_is_not_enough() {
        let error = combine(&[quote("1.40", "700"), failed(), failed()]).unwrap_err();
        assert_eq!(error.code(), "rates_unavailable");
    }

    #[test]
    fn a_value_out_of_bounds_is_left_out() {
        let zero = Ok(Quote {
            source: "broken".to_string(),
            usd_cad: exact::zero(),
            usd_clp: exact::zero(),
        });
        let combined = combine(&[quote("1.40", "700"), zero, quote("1.40", "700")]).unwrap();
        assert_eq!(combined.usd_cad, "1.4000");
        assert_eq!(combined.cad_clp, "700.00");
    }
}
