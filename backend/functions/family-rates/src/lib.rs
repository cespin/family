//! The public exchange rate services the family's rates come from. Each is asked for 1 USD in CAD
//! and in CLP, and `family_ledger::rules::rates` combines the answers.
//!
//! What each service needs, checked on 2026-11-23:
//! - **Frankfurter v2** blends central bank reference rates, including the Bank of Canada's and the
//!   Banco Central de Chile's. No key and no quota. v1 has no CLP, so it must stay on v2.
//! - **ExchangeRate-API's open endpoint** updates daily and needs no key, but its terms require a
//!   visible link to exchangerate-api.com, which the frontend's settings screen shows. It answers
//!   HTTP 429 for about 20 minutes when rate limited.
//! - **fawazahmed0's currency API** updates daily and is CC0. Its README asks clients to fall back to
//!   the pages.dev mirror when jsDelivr fails, so both are tried.
//!
//! Every service answers JSON numbers. They are read as their raw text and parsed as exact decimals,
//! so no float ever touches a rate. Requests carry a generic User-Agent and nothing about the family.

use std::collections::HashMap;
use std::time::Duration;

use family_core::{ApiError, Result};
use family_ledger::rules::exact::{self, Exact};
use family_ledger::rules::rates::Quote;
use family_ledger::service::rates::RateFetcher;
use serde::Deserialize;
use serde_json::value::RawValue;

pub const FRANKFURTER: &str = "frankfurter";
pub const EXCHANGE_RATE_API: &str = "exchange-rate-api";
pub const FAWAZAHMED0: &str = "fawazahmed0";

const FRANKFURTER_URL: &str = "https://api.frankfurter.dev/v2/rates?base=USD&quotes=CAD,CLP";
const EXCHANGE_RATE_API_URL: &str = "https://open.er-api.com/v6/latest/USD";
const FAWAZAHMED0_URLS: [&str; 2] = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];

/// Each request gives up after this long, so a slow service cannot hold up the other two.
const TIMEOUT: Duration = Duration::from_secs(4);
const USER_AGENT: &str = "family-dashboard";

fn failed(source: &str, why: impl std::fmt::Display) -> ApiError {
    ApiError::rates_unavailable(format!("{source}: {why}"))
}

/// A JSON number, read exactly from its text.
fn number(source: &str, what: &str, raw: Option<&RawValue>) -> Result<Exact> {
    let raw = raw.ok_or_else(|| failed(source, format!("no {what} rate")))?;
    exact::decimal(raw.get().trim()).ok_or_else(|| {
        failed(
            source,
            format!("the {what} rate {} is not a decimal", raw.get()),
        )
    })
}

fn quote(source: &str, usd_cad: Option<&RawValue>, usd_clp: Option<&RawValue>) -> Result<Quote> {
    Ok(Quote {
        source: source.to_string(),
        usd_cad: number(source, "CAD", usd_cad)?,
        usd_clp: number(source, "CLP", usd_clp)?,
    })
}

fn json<'a, T: Deserialize<'a>>(source: &str, body: &'a str) -> Result<T> {
    serde_json::from_str(body).map_err(|e| failed(source, format!("unreadable answer: {e}")))
}

#[derive(Deserialize)]
struct FrankfurterRow<'a> {
    quote: String,
    #[serde(borrow)]
    rate: &'a RawValue,
}

/// `[{ "quote": "CAD", "rate": 1.4328 }, { "quote": "CLP", "rate": 1019.32 }]`.
pub fn parse_frankfurter(body: &str) -> Result<Quote> {
    let rows: Vec<FrankfurterRow> = json(FRANKFURTER, body)?;
    let rate = |code: &str| {
        rows.iter()
            .find(|row| row.quote == code)
            .map(|row| row.rate)
    };
    quote(FRANKFURTER, rate("CAD"), rate("CLP"))
}

#[derive(Deserialize)]
struct ExchangeRateApiAnswer<'a> {
    result: String,
    #[serde(borrow, default)]
    rates: HashMap<String, &'a RawValue>,
}

/// `{ "result": "success", "rates": { "CAD": 1.435985, "CLP": 1023.741046 } }`.
pub fn parse_exchange_rate_api(body: &str) -> Result<Quote> {
    let answer: ExchangeRateApiAnswer = json(EXCHANGE_RATE_API, body)?;
    if answer.result != "success" {
        return Err(failed(
            EXCHANGE_RATE_API,
            format!("result {}", answer.result),
        ));
    }
    let rate = |code: &str| answer.rates.get(code).copied();
    quote(EXCHANGE_RATE_API, rate("CAD"), rate("CLP"))
}

#[derive(Deserialize)]
struct Fawazahmed0Answer<'a> {
    #[serde(borrow)]
    usd: HashMap<String, &'a RawValue>,
}

/// `{ "usd": { "cad": 1.43175366, "clp": 1022.12383338 } }`.
pub fn parse_fawazahmed0(body: &str) -> Result<Quote> {
    let answer: Fawazahmed0Answer = json(FAWAZAHMED0, body)?;
    let rate = |code: &str| answer.usd.get(code).copied();
    quote(FAWAZAHMED0, rate("cad"), rate("clp"))
}

/// The services, asked over HTTPS.
pub struct PublicRates {
    agent: ureq::Agent,
}

impl Default for PublicRates {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .build()
            .into();
        Self { agent }
    }
}

impl PublicRates {
    /// Blocking, so it runs on the blocking pool. Anything but 200 is a failure.
    async fn get(&self, source: &'static str, url: &'static str) -> Result<String> {
        let agent = self.agent.clone();
        tokio::task::spawn_blocking(move || {
            let mut response = agent.get(url).call().map_err(|e| failed(source, e))?;
            let status = response.status().as_u16();
            if status != 200 {
                return Err(failed(source, format!("HTTP {status}")));
            }
            response
                .body_mut()
                .read_to_string()
                .map_err(|e| failed(source, format!("unreadable body: {e}")))
        })
        .await
        .map_err(|e| failed(source, format!("the request task failed: {e}")))?
    }

    async fn frankfurter(&self) -> Result<Quote> {
        parse_frankfurter(&self.get(FRANKFURTER, FRANKFURTER_URL).await?)
    }

    async fn exchange_rate_api(&self) -> Result<Quote> {
        parse_exchange_rate_api(&self.get(EXCHANGE_RATE_API, EXCHANGE_RATE_API_URL).await?)
    }

    async fn fawazahmed0(&self) -> Result<Quote> {
        let mut last = None;
        for url in FAWAZAHMED0_URLS {
            match self
                .get(FAWAZAHMED0, url)
                .await
                .and_then(|body| parse_fawazahmed0(&body))
            {
                Ok(quote) => return Ok(quote),
                Err(error) => {
                    tracing::warn!("{error}, trying the next mirror");
                    last = Some(error);
                }
            }
        }
        Err(last.unwrap_or_else(|| failed(FAWAZAHMED0, "no mirror was tried")))
    }
}

impl RateFetcher for PublicRates {
    async fn fetch(&self) -> Vec<Result<Quote>> {
        let (frankfurter, exchange_rate_api, fawazahmed0) = tokio::join!(
            self.frankfurter(),
            self.exchange_rate_api(),
            self.fawazahmed0()
        );
        let answers = vec![frankfurter, exchange_rate_api, fawazahmed0];
        for error in answers.iter().filter_map(|answer| answer.as_ref().err()) {
            tracing::warn!("a rate service failed: {error}");
        }
        answers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(text: &str) -> Exact {
        exact::decimal(text).unwrap()
    }

    #[test]
    fn reads_frankfurter_rows_by_quote() {
        let quote = parse_frankfurter(include_str!("../tests/fixtures/frankfurter.json")).unwrap();
        assert_eq!(quote.source, FRANKFURTER);
        assert_eq!(quote.usd_cad, decimal("1.4328"));
        assert_eq!(quote.usd_clp, decimal("1019.32"));
    }

    #[test]
    fn reads_exchange_rate_api_exactly() {
        let body = include_str!("../tests/fixtures/exchange-rate-api.json");
        let quote = parse_exchange_rate_api(body).unwrap();
        assert_eq!(quote.usd_cad, decimal("1.435985"));
        assert_eq!(quote.usd_clp, decimal("1023.741046"));
    }

    #[test]
    fn reads_fawazahmed0_in_lowercase() {
        let quote = parse_fawazahmed0(include_str!("../tests/fixtures/fawazahmed0.json")).unwrap();
        assert_eq!(quote.usd_cad, decimal("1.43175366"));
        assert_eq!(quote.usd_clp, decimal("1022.12383338"));
    }

    #[test]
    fn an_exchange_rate_api_error_is_a_failure() {
        let error =
            parse_exchange_rate_api(r#"{"result":"error","error-type":"quota"}"#).unwrap_err();
        assert_eq!(error.code(), "rates_unavailable");
    }

    #[test]
    fn a_missing_currency_is_a_failure() {
        let error = parse_frankfurter(r#"[{"quote":"CAD","rate":1.43}]"#).unwrap_err();
        assert!(error.to_string().contains("no CLP rate"), "{error}");
    }

    #[test]
    fn a_number_in_exponent_form_is_a_failure_not_a_guess() {
        let error = parse_fawazahmed0(r#"{"usd":{"cad":1.43,"clp":1.02e3}}"#).unwrap_err();
        assert!(error.to_string().contains("not a decimal"), "{error}");
    }

    /// Asks the real services. It needs the network, so `cargo test --workspace` skips it:
    /// `cargo test -p family-rates -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "asks the real rate services over the network"]
    async fn the_real_services_answer_and_agree() {
        let answers = PublicRates::default().fetch().await;
        for answer in &answers {
            println!("{answer:?}");
        }
        assert!(answers.iter().all(Result::is_ok), "{answers:?}");
        let combined = family_ledger::rules::rates::combine(&answers).unwrap();
        println!("{combined:?}");
    }

    #[test]
    fn a_body_that_is_not_json_is_a_failure() {
        assert!(parse_frankfurter("<html>").is_err());
    }
}
