//! Keeping the exchange rates current: when a ledger read starts the background update, and what a
//! refresh does when the services answer, fail, or another refresh got there first.

mod support;

use std::sync::atomic::Ordering;

use family_ledger::service::rates::{refresh, Outcome, Requester};
use serde_json::{json, Value};
use support::fake_table::FakeTable;
use support::fixtures::{base_items, Items};
use support::router::{send_with, FakeFetcher, FakeUpdate, FixedEnv};

/// The router's clock is 2026-11-18T12:00:00Z.
const SEVEN_HOURS_AGO: &str = "2026-11-18T05:00:00Z";
const FIVE_MINUTES_AGO: &str = "2026-11-18T11:55:00Z";
const THIRTY_SECONDS_AGO: &str = "2026-11-18T11:59:30Z";

fn status_key() -> (String, String) {
    ("RATES".to_string(), "STATUS".to_string())
}

fn head_key() -> (String, String) {
    ("LEDGER#main".to_string(), "HEAD".to_string())
}

/// The base data with its rates status changed.
fn with_status(fields: Value) -> Items {
    let mut items = base_items();
    let status = items
        .get_mut(&status_key())
        .expect("the base data has a rates status");
    for (name, value) in fields.as_object().unwrap() {
        status.insert(name.clone(), value.clone());
    }
    items
}

fn rate_entries(items: &Items) -> Vec<&serde_json::Map<String, Value>> {
    items
        .iter()
        .filter(|((pk, sk), _)| pk == "LEDGER#main" && sk.starts_with("RATE#"))
        .map(|(_, item)| item)
        .collect()
}

async fn read_ledger(table: &FakeTable, update: &FakeUpdate) -> Value {
    let fetcher = FakeFetcher::new(None);
    let answer = send_with(
        table,
        &fetcher,
        update,
        "carlos",
        "GET",
        "/api/ledger",
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    answer.body
}

#[tokio::test]
async fn a_fresh_check_starts_nothing() {
    let table = FakeTable::seeded(base_items());
    let update = FakeUpdate::default();
    let body = read_ledger(&table, &update).await;
    assert_eq!(*update.starts.lock().unwrap(), 0);
    assert_eq!(body["exchangeRatesUpdating"], json!(false));
    assert_eq!(
        body["exchangeRatesCheckedAt"],
        json!("2026-11-18T09:00:00Z")
    );
}

#[tokio::test]
async fn a_check_older_than_six_hours_starts_the_update_and_still_answers() {
    let table = FakeTable::seeded(with_status(json!({
        "checkedAt": SEVEN_HOURS_AGO,
        "attemptedAt": SEVEN_HOURS_AGO,
    })));
    let update = FakeUpdate::default();
    let body = read_ledger(&table, &update).await;
    assert_eq!(*update.starts.lock().unwrap(), 1);
    assert_eq!(body["exchangeRatesUpdating"], json!(true));
    // The rates in force are still shown while the update runs.
    assert_eq!(body["exchangeRates"][0]["usdCad"], json!("1.4000"));
}

#[tokio::test]
async fn rates_never_checked_start_the_update() {
    let mut items = base_items();
    items.remove(&status_key());
    let table = FakeTable::seeded(items);
    let update = FakeUpdate::default();
    read_ledger(&table, &update).await;
    assert_eq!(*update.starts.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_recent_attempt_holds_the_update_back() {
    let table = FakeTable::seeded(with_status(json!({
        "checkedAt": SEVEN_HOURS_AGO,
        "attemptedAt": FIVE_MINUTES_AGO,
    })));
    let update = FakeUpdate::default();
    let body = read_ledger(&table, &update).await;
    assert_eq!(*update.starts.lock().unwrap(), 0);
    assert_eq!(body["exchangeRatesUpdating"], json!(false));
}

#[tokio::test]
async fn an_update_that_cannot_start_never_fails_the_read() {
    let table = FakeTable::seeded(with_status(json!({ "checkedAt": SEVEN_HOURS_AGO })));
    let update = FakeUpdate {
        refuse: true,
        ..FakeUpdate::default()
    };
    let body = read_ledger(&table, &update).await;
    assert_eq!(*update.starts.lock().unwrap(), 1);
    assert_eq!(body["exchangeRatesUpdating"], json!(false));
}

#[tokio::test]
async fn the_background_update_skips_a_fresh_check_without_asking() {
    let table = FakeTable::seeded(base_items());
    let fetcher = FakeFetcher::new(None);
    let outcome = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Background,
    )
    .await;
    assert_eq!(outcome.unwrap(), Outcome::Skipped);
    assert_eq!(fetcher.calls.load(Ordering::Relaxed), 0);
    assert_eq!(table.snapshot(), base_items());
}

#[tokio::test]
async fn the_background_update_saves_new_rates_as_nobody() {
    let before =
        with_status(json!({ "checkedAt": SEVEN_HOURS_AGO, "attemptedAt": SEVEN_HOURS_AGO }));
    let table = FakeTable::seeded(before.clone());
    let fetcher = FakeFetcher::new(None);
    let outcome = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Background,
    )
    .await;
    assert_eq!(outcome.unwrap(), Outcome::Saved);

    let after = table.snapshot();
    assert_eq!(rate_entries(&after).len(), rate_entries(&before).len() + 1);
    let saved = rate_entries(&after)
        .into_iter()
        .find(|item| item["fetchedAt"] == json!("2026-11-18T12:00:00Z"))
        .expect("the new entry");
    assert_eq!(saved["usdCad"], json!("1.4100"));
    assert_eq!(saved["cadClp"], json!("672.00"));
    assert!(saved.get("enteredBy").is_none());
    assert_eq!(
        after[&head_key()]["rev"].as_u64(),
        before[&head_key()]["rev"].as_u64().map(|rev| rev + 1)
    );
    let status = &after[&status_key()];
    assert_eq!(status["checkedAt"], json!("2026-11-18T12:00:00Z"));
    assert_eq!(status["lastAnswers"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn unchanged_rates_only_move_the_check() {
    let before =
        with_status(json!({ "checkedAt": SEVEN_HOURS_AGO, "attemptedAt": SEVEN_HOURS_AGO }));
    let table = FakeTable::seeded(before.clone());
    let answers = json!([
        { "usdCad": "1.40", "usdClp": "938" },
        { "usdCad": "1.40", "usdClp": "938" },
        { "usdCad": "1.40", "usdClp": "938" },
    ]);
    let fetcher = FakeFetcher::new(Some(&answers));
    let outcome = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Background,
    )
    .await;
    assert_eq!(outcome.unwrap(), Outcome::Unchanged);

    let mut after = table.snapshot();
    assert_eq!(
        after[&status_key()]["checkedAt"],
        json!("2026-11-18T12:00:00Z")
    );
    let mut before = before;
    after.remove(&status_key());
    before.remove(&status_key());
    assert_eq!(after, before, "the ledger must not change");
}

#[tokio::test]
async fn a_member_asking_again_within_a_minute_asks_nobody() {
    let table = FakeTable::seeded(with_status(json!({ "attemptedAt": THIRTY_SECONDS_AGO })));
    let fetcher = FakeFetcher::new(None);
    let answer = send_with(
        &table,
        &fetcher,
        &FakeUpdate::default(),
        "carlos",
        "POST",
        "/api/exchange-rates/refresh",
        None,
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(answer.body["updated"], json!(false));
    assert_eq!(answer.body["exchangeRate"]["usdCad"], json!("1.4000"));
    assert_eq!(fetcher.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn a_member_may_ask_even_when_the_check_is_fresh() {
    let table = FakeTable::seeded(base_items());
    let fetcher = FakeFetcher::new(None);
    let outcome = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Member("carlos@example.test"),
    )
    .await;
    assert_eq!(outcome.unwrap(), Outcome::Saved);
    assert_eq!(fetcher.calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_refresh_that_loses_the_lease_asks_nobody() {
    let before =
        with_status(json!({ "checkedAt": SEVEN_HOURS_AGO, "attemptedAt": SEVEN_HOURS_AGO }));
    let table = FakeTable::seeded(before);
    // Another refresh takes the lease between this one's read of the status and its write.
    table.before_commit(|items| {
        let status = items.get_mut(&status_key()).unwrap();
        let rev = status["rev"].as_u64().unwrap();
        status.insert("rev".to_string(), json!(rev + 1));
        status.insert("attemptedAt".to_string(), json!("2026-11-18T12:00:00Z"));
    });
    let fetcher = FakeFetcher::new(None);
    let outcome = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Background,
    )
    .await;
    assert_eq!(outcome.unwrap(), Outcome::Skipped);
    assert_eq!(fetcher.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn services_that_fail_keep_the_rates_and_record_the_attempt() {
    let before =
        with_status(json!({ "checkedAt": SEVEN_HOURS_AGO, "attemptedAt": SEVEN_HOURS_AGO }));
    let table = FakeTable::seeded(before.clone());
    let answers = json!([{ "usdCad": "1.40", "usdClp": "938" }, null, null]);
    let fetcher = FakeFetcher::new(Some(&answers));
    let error = refresh(
        &table,
        &fetcher,
        &FixedEnv::default(),
        Requester::Background,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "rates_unavailable");

    let after = table.snapshot();
    assert_eq!(rate_entries(&after), rate_entries(&before));
    let status = &after[&status_key()];
    assert_eq!(status["checkedAt"], json!(SEVEN_HOURS_AGO));
    assert_eq!(status["attemptedAt"], json!("2026-11-18T12:00:00Z"));
    assert!(status["lastAnswers"][1]["error"].is_string());
}
