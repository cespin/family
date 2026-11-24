//! Keeping the exchange rates current from the public rate services.
//!
//! Nobody types rates in. `GET /api/ledger` starts a background update when the last check is older
//! than six hours, and `POST /api/exchange-rates/refresh` lets a member ask for one and wait. Both
//! go through [`refresh`], which takes a lease on the status item so concurrent triggers fetch once.

use std::future::Future;

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde_json::{json, Value};

use crate::consistent_read;
use crate::model::{RateEntry, RatesStatus, SourceAnswer, Stamp};
use crate::protocol::write::{
    commit, commit_as_operator, kept_losing, Commit, WritePlan, WRITE_TRIES,
};
use crate::rules::exact;
use crate::rules::rates::{combine, Combined, Quote};
use crate::service::access::member_of;
use crate::service::env::{seconds_of, Env};
use crate::service::reads::rate_json;
use crate::service::view::LedgerView;
use crate::store::keys;
use crate::store::table::{from_item, rev_of, to_item, Guard, Table, TxOp, TxOutcome};

/// A check older than this starts an update.
pub const STALE_AFTER_SECONDS: i64 = 6 * 3600;
/// After an attempt, background updates wait this long, so failing services are not hammered.
pub const RETRY_AFTER_SECONDS: i64 = 15 * 60;
/// After an attempt, a member's request waits this long before the services are asked again.
pub const MANUAL_COOLDOWN_SECONDS: i64 = 60;

/// Asks the public rate services, one answer per service.
pub trait RateFetcher: Send + Sync {
    fn fetch(&self) -> impl Future<Output = Vec<Result<Quote>>> + Send;
}

/// Starts a background update without waiting for it to finish.
pub trait RatesUpdate: Send + Sync {
    fn start(&self) -> impl Future<Output = Result<()>> + Send;
}

/// Who a refresh writes as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requester<'a> {
    /// The background update. It skips a check that is still fresh.
    Background,
    /// A member who pressed the button, by their private email for the allowlist check.
    Member(&'a str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing was asked: the check is fresh, another refresh holds the lease, or it ran too
    /// recently.
    Skipped,
    /// The services agree with the rates already in force.
    Unchanged,
    /// A new rate entry was saved.
    Saved,
}

/// The status item, with its own revision. A missing item reads as empty at revision 0.
pub async fn read_status<T: Table>(table: &T) -> Result<(RatesStatus, u64)> {
    match table.get(&keys::rates_status()).await? {
        Some(item) => Ok((from_item(&item)?, rev_of(&item))),
        None => Ok((RatesStatus::default(), 0)),
    }
}

/// Saves the status item if it is still at `rev`. False when another refresh wrote it first.
async fn write_status<T: Table>(table: &T, status: &RatesStatus, rev: u64) -> Result<bool> {
    let item = to_item(&keys::rates_status(), status, rev + 1)?;
    let ops = vec![TxOp::Put {
        item,
        guard: Guard::Rev(rev),
    }];
    Ok(table.transact(ops).await? == TxOutcome::Committed)
}

fn within(at: Option<&str>, now: i64, window: i64) -> bool {
    at.and_then(seconds_of)
        .is_some_and(|then| now - then < window)
}

fn seconds_now<E: Env>(env: &E) -> Result<(String, i64)> {
    let now = env.now();
    let seconds = seconds_of(&now).ok_or_else(|| ApiError::internal("the clock is unreadable"))?;
    Ok((now, seconds))
}

/// Whether a ledger read should start a background update: the last check is older than six
/// hours, or there was none, and no attempt was made in the last 15 minutes.
pub fn needs_update(status: &RatesStatus, now: &str) -> bool {
    let Some(now) = seconds_of(now) else {
        return false;
    };
    !within(status.checked_at.as_deref(), now, STALE_AFTER_SECONDS)
        && !within(status.attempted_at.as_deref(), now, RETRY_AFTER_SECONDS)
}

fn answers_of(answers: &[Result<Quote>]) -> Vec<SourceAnswer> {
    answers
        .iter()
        .enumerate()
        .map(|(index, answer)| match answer {
            Ok(quote) => SourceAnswer {
                source: quote.source.clone(),
                usd_cad: Some(exact::to_text(&quote.usd_cad)),
                usd_clp: Some(exact::to_text(&quote.usd_clp)),
                error: None,
            },
            Err(error) => SourceAnswer {
                source: format!("source-{}", index + 1),
                usd_cad: None,
                usd_clp: None,
                error: Some(error.to_string()),
            },
        })
        .collect()
}

/// Appends the combined rates unless they equal the ones in force. True when an entry was saved.
async fn save<T: Table, E: Env>(
    table: &T,
    env: &E,
    now: &str,
    combined: &Combined,
    requester: Requester<'_>,
) -> Result<bool> {
    for _ in 0..WRITE_TRIES {
        let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
        let latest = view.rates.last();
        if latest.is_some_and(|rate| {
            rate.usd_cad == combined.usd_cad && rate.cad_clp == combined.cad_clp
        }) {
            return Ok(false);
        }
        let new_rev = rev + 1;
        // The clock never runs backwards in practice, but an entry must never predate the last one.
        let today = &now[..10];
        let date = match latest {
            Some(rate) if today < rate.date.as_str() => rate.date.clone(),
            _ => today.to_string(),
        };
        let id = env.new_id();
        let entry = RateEntry {
            id: id.clone(),
            usd_cad: combined.usd_cad.clone(),
            cad_clp: combined.cad_clp.clone(),
            date,
            entered_by: None,
            fetched_at: Some(now.to_string()),
            seq: new_rev,
            stamp: Stamp {
                rev: new_rev,
                last_request_id: None,
                last_request_hash: None,
            },
        };
        let items = vec![to_item(&keys::rate(&id), &entry, new_rev)?];
        let outcome = match requester {
            Requester::Member(email) => {
                let plan = WritePlan {
                    items,
                    unstamped: Vec::new(),
                };
                commit(table, rev, email, plan).await?
            }
            Requester::Background => commit_as_operator(table, rev, items).await?,
        };
        if outcome == Commit::Saved {
            return Ok(true);
        }
    }
    Err(kept_losing())
}

/// Asks the services and saves what they agree on, as `docs/frontend-requirements.md` describes.
/// When they do not answer well enough, the rates in force stay and the error says why.
pub async fn refresh<T: Table, F: RateFetcher, E: Env>(
    table: &T,
    fetcher: &F,
    env: &E,
    requester: Requester<'_>,
) -> Result<Outcome> {
    let (now, seconds) = seconds_now(env)?;
    let (mut status, rev) = read_status(table).await?;
    let wait = match requester {
        Requester::Background => {
            if within(status.checked_at.as_deref(), seconds, STALE_AFTER_SECONDS) {
                return Ok(Outcome::Skipped);
            }
            RETRY_AFTER_SECONDS
        }
        Requester::Member(_) => MANUAL_COOLDOWN_SECONDS,
    };
    if within(status.attempted_at.as_deref(), seconds, wait) {
        return Ok(Outcome::Skipped);
    }

    // The lease: only the refresh that moves the status item on asks the services.
    status.attempted_at = Some(now.clone());
    if !write_status(table, &status, rev).await? {
        return Ok(Outcome::Skipped);
    }
    let rev = rev + 1;

    let answers = fetcher.fetch().await;
    status.last_answers = answers_of(&answers);
    let combined = match combine(&answers) {
        Ok(combined) => combined,
        Err(error) => {
            write_status(table, &status, rev).await?;
            return Err(error);
        }
    };
    let saved = save(table, env, &now, &combined, requester).await?;
    status.checked_at = Some(now);
    if !write_status(table, &status, rev).await? {
        tracing::warn!("another refresh wrote the rates status first");
    }
    Ok(if saved {
        Outcome::Saved
    } else {
        Outcome::Unchanged
    })
}

/// `POST /api/exchange-rates/refresh`: the rates in force after asking, and whether they changed.
pub async fn refresh_rates<T: Table, F: RateFetcher, E: Env>(
    table: &T,
    fetcher: &F,
    env: &E,
    caller: &Caller,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let outcome = refresh(table, fetcher, env, Requester::Member(&signed.email)).await?;
    let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
    let (status, _) = read_status(table).await?;
    Ok(json!({
        "revision": rev,
        "updated": outcome == Outcome::Saved,
        "exchangeRate": view.rates.last().map(rate_json),
        "exchangeRatesCheckedAt": status.checked_at,
    }))
}
