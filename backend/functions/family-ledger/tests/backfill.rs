//! The one-time transaction date backfill, run on the base data as it was stored before
//! transaction dates existed.

mod support;

use family_ledger::service::backfill::{transaction_dates, Backfilled};
use serde_json::Value;
use support::fake_table::FakeTable;
use support::fixtures::{before_transaction_dates, is_list_entry, Items};
use support::router::send;

const DAY: &str = "2026-11-19";

fn is_record(pk: &str, sk: &str) -> bool {
    pk == "LEDGER#main" && (sk.starts_with("EXPENSE#") || sk.starts_with("PAYMENT#"))
}

fn head_rev(items: &Items) -> u64 {
    items[&("LEDGER#main".to_string(), "HEAD".to_string())]["rev"]
        .as_u64()
        .unwrap()
}

fn count(items: &Items, prefix: &str) -> usize {
    items
        .keys()
        .filter(|(pk, sk)| pk == "LEDGER#main" && sk.starts_with(prefix))
        .count()
}

fn retired(item: &serde_json::Map<String, Value>) -> bool {
    item.get("removed") == Some(&Value::Bool(true))
}

#[tokio::test]
async fn items_saved_before_transaction_dates_read_their_entry_date() {
    let table = FakeTable::seeded(before_transaction_dates());
    let answer = send(&table, "carlos", "GET", "/api/expenses?limit=100", None).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    for row in answer.body["expenses"].as_array().unwrap() {
        assert_eq!(row["transactionDate"], row["date"], "{row}");
    }
    let answer = send(&table, "carlos", "GET", "/api/payments?limit=100", None).await;
    for row in answer.body["payments"].as_array().unwrap() {
        assert_eq!(row["transactionDate"], row["date"], "{row}");
        assert_eq!(row["version"], 1, "{row}");
    }
}

#[tokio::test]
async fn a_dry_run_counts_and_changes_nothing() {
    let before = before_transaction_dates();
    let table = FakeTable::seeded(before.clone());
    let done = transaction_dates(&table, DAY, true).await.unwrap();
    assert_eq!(
        done,
        Backfilled {
            expenses: count(&before, "EXPENSE#"),
            payments: count(&before, "PAYMENT#"),
        }
    );
    assert_eq!(table.snapshot(), before);
}

#[tokio::test]
async fn every_record_gets_the_day_and_its_list_entries_move_to_it() {
    let before = before_transaction_dates();
    let table = FakeTable::seeded(before.clone());
    let done = transaction_dates(&table, DAY, false).await.unwrap();
    let (expenses, payments) = (count(&before, "EXPENSE#"), count(&before, "PAYMENT#"));
    assert_eq!(done, Backfilled { expenses, payments });

    let after = table.snapshot();
    assert_eq!(
        head_rev(&after),
        head_rev(&before) + (expenses + payments) as u64,
        "one write per record"
    );
    for ((pk, sk), item) in &after {
        if is_record(pk, sk) {
            assert_eq!(item["transactionDate"], DAY, "{sk}");
            assert_eq!(
                item["date"],
                before[&(pk.clone(), sk.clone())]["date"],
                "{sk}"
            );
        }
        if is_list_entry(pk) && !retired(item) {
            assert!(sk.starts_with(&format!("{DAY}#")), "{pk} {sk} did not move");
            assert_eq!(item["transactionDate"], DAY, "{pk} {sk}");
        }
        // Debts, credits and allocations follow the entry date, so the backfill moves no money.
        if sk.starts_with("PAIR#") || sk.starts_with("ALLOC#") {
            assert_eq!(Some(item), before.get(&(pk.clone(), sk.clone())), "{sk}");
        }
    }
    for (pk, sk) in before.keys() {
        if is_list_entry(pk) {
            assert!(retired(&after[&(pk.clone(), sk.clone())]), "{pk} {sk}");
        }
    }

    let answer = send(&table, "carlos", "GET", "/api/expenses?limit=100", None).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    let rows = answer.body["expenses"].as_array().unwrap();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|row| row["transactionDate"] == DAY));
}

#[tokio::test]
async fn running_it_again_changes_nothing() {
    let table = FakeTable::seeded(before_transaction_dates());
    transaction_dates(&table, DAY, false).await.unwrap();
    let once = table.snapshot();
    let again = transaction_dates(&table, "2026-12-01", false)
        .await
        .unwrap();
    assert_eq!(again, Backfilled::default());
    assert_eq!(table.snapshot(), once);
}

#[tokio::test]
async fn a_corrected_record_is_left_alone() {
    let table = FakeTable::seeded(before_transaction_dates());
    transaction_dates(&table, DAY, false).await.unwrap();
    let payment = send(&table, "carlos", "GET", "/api/payments?limit=1", None).await;
    let row = &payment.body["payments"][0];
    let path = format!("/api/payments/{}", row["id"].as_str().unwrap());
    let body = serde_json::json!({
        "requestId": "90000000-0000-4000-8000-000000000001",
        "transactionDate": "2026-08-05",
        "version": row["version"],
    });
    let answer = send(&table, "carlos", "PUT", &path, Some(&body)).await;
    assert_eq!(answer.status, 200, "{}", answer.body);

    transaction_dates(&table, DAY, false).await.unwrap();
    let answer = send(&table, "carlos", "GET", "/api/payments?limit=100", None).await;
    let corrected = answer.body["payments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == row["id"])
        .unwrap();
    assert_eq!(corrected["transactionDate"], "2026-08-05");
    assert_eq!(corrected["version"], 2);
}

#[tokio::test]
async fn a_write_that_lands_first_makes_it_read_again() {
    let before = before_transaction_dates();
    let table = FakeTable::seeded(before.clone());
    // Another write moves the head between the backfill's read and its first commit.
    table.before_commit(|items| {
        let head = items
            .get_mut(&("LEDGER#main".to_string(), "HEAD".to_string()))
            .unwrap();
        let rev = head["rev"].as_u64().unwrap();
        head.insert("rev".to_string(), Value::from(rev + 1));
        head.insert("lastWrite".to_string(), Value::Array(Vec::new()));
    });
    let done = transaction_dates(&table, DAY, false).await.unwrap();
    assert_eq!(done.expenses, count(&before, "EXPENSE#"));
    assert_eq!(done.payments, count(&before, "PAYMENT#"));
    assert_eq!(
        head_rev(&table.snapshot()),
        head_rev(&before) + 1 + (done.expenses + done.payments) as u64
    );
}

#[tokio::test]
async fn a_day_that_does_not_exist_is_refused() {
    let before = before_transaction_dates();
    let table = FakeTable::seeded(before.clone());
    assert!(transaction_dates(&table, "2026-11-31", false)
        .await
        .is_err());
    assert_eq!(table.snapshot(), before);
}
