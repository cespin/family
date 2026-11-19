//! Currencies, conversion and the tolerance for full payments.

use family_core::{ApiError, Result};
use serde::{Deserialize, Serialize};

use super::exact::{self, Exact};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Currency {
    Cad,
    Usd,
    Clp,
}

impl Currency {
    pub fn digits(self) -> u32 {
        match self {
            Self::Cad | Self::Usd => 2,
            Self::Clp => 0,
        }
    }

    /// The largest amount one expense can have, in minor units.
    pub fn expense_limit(self) -> i64 {
        match self {
            Self::Cad | Self::Usd => 1_000_000,
            Self::Clp => 10_000_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Money {
    pub amount_minor: i64,
    pub currency: Currency,
}

/// The rates in force when an event was recorded, as they are stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRates {
    pub usd_cad: String,
    pub cad_clp: String,
}

impl RecordedRates {
    pub fn exact(&self) -> Result<Rates> {
        match (exact::decimal(&self.usd_cad), exact::decimal(&self.cad_clp)) {
            (Some(usd_cad), Some(cad_clp)) => Ok(Rates { usd_cad, cad_clp }),
            _ => Err(ApiError::internal(
                "a stored exchange rate is not a decimal",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rates {
    pub usd_cad: Exact,
    pub cad_clp: Exact,
}

impl Rates {
    fn cad_per(&self, currency: Currency) -> Exact {
        match currency {
            Currency::Cad => exact::one(),
            Currency::Usd => self.usd_cad.clone(),
            Currency::Clp => exact::one() / &self.cad_clp,
        }
    }
}

/// Converts minor units exactly. `None` when the rates needed are missing.
pub fn convert(
    value: &Exact,
    from: Currency,
    to: Currency,
    rates: Option<&Rates>,
) -> Option<Exact> {
    if from == to {
        return Some(value.clone());
    }
    let rates = rates?;
    let major = value / exact::power_of_ten(from.digits());
    let cad = major * rates.cad_per(from);
    Some(cad / rates.cad_per(to) * exact::power_of_ten(to.digits()))
}

/// Whether a credited value is within one minor unit of the paying currency.
pub fn within_tolerance(paid: &Money, credited: &Money, rates: Option<&Rates>) -> bool {
    let converted = convert(
        &exact::whole(paid.amount_minor),
        paid.currency,
        credited.currency,
        rates,
    );
    let unit = convert(&exact::one(), paid.currency, credited.currency, rates);
    match (converted, unit) {
        (Some(converted), Some(unit)) => {
            let gap = converted - exact::whole(credited.amount_minor);
            let distance = if gap < exact::zero() { -gap } else { gap };
            distance <= unit
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rates() -> Rates {
        RecordedRates {
            usd_cad: "1.40".into(),
            cad_clp: "670".into(),
        }
        .exact()
        .unwrap()
    }

    fn money(amount_minor: i64, currency: Currency) -> Money {
        Money {
            amount_minor,
            currency,
        }
    }

    #[test]
    fn converts_through_the_family_rates() {
        let clp = convert(
            &exact::whole(3963),
            Currency::Cad,
            Currency::Clp,
            Some(&rates()),
        );
        assert_eq!(exact::round(&clp.unwrap()), 26552);
        let usd = convert(
            &exact::whole(7500),
            Currency::Cad,
            Currency::Usd,
            Some(&rates()),
        );
        assert_eq!(exact::round(&usd.unwrap()), 5357);
    }

    #[test]
    fn a_missing_rate_means_a_missing_result() {
        assert_eq!(
            convert(&exact::whole(1), Currency::Cad, Currency::Clp, None),
            None
        );
        assert_eq!(
            convert(&exact::whole(1), Currency::Clp, Currency::Clp, None),
            Some(exact::whole(1))
        );
    }

    #[test]
    fn the_tolerance_is_one_minor_unit_of_the_paying_currency() {
        let debt = money(26550, Currency::Clp);
        assert!(within_tolerance(
            &money(3963, Currency::Cad),
            &debt,
            Some(&rates())
        ));
        assert!(!within_tolerance(
            &money(4000, Currency::Cad),
            &debt,
            Some(&rates())
        ));
        assert!(!within_tolerance(&money(3963, Currency::Cad), &debt, None));
    }
}
