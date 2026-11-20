//! The list entry backfill, run on the base data as it was stored before list entries carried
//! the split.

mod support;

use family_ledger::service::backfill::list_entries;
use serde_json::Value;
use support::fake_table::FakeTable;
use support::fixtures::{base_items, before_list_shares, Items};
use support::router::send;

fn head_rev(items: &Items) -> u64 {
    items[&("LEDGER#main".to_string(), "HEAD".to_string())]["rev"]
        .as_u64()
        .unwrap()
}

fn expense_count(items: &Items) -> usize {
    items
        .keys()
        .filter(|(pk, sk)| pk == "LEDGER#main" && sk.starts_with("EXPENSE#"))
        .count()
}

fn is_expense_entry(pk: &str) -> bool {
    pk.ends_with("#EXPENSES") || pk.contains("#KIND#")
}

/// The items, with each item's `rev` left out, since the backfill moves the head.
fn without_revs(items: &Items) -> Items {
    items
        .iter()
        .filter(|((_, sk), _)| sk != "HEAD")
        .map(|(key, item)| {
            let mut item = item.clone();
            item.remove("rev");
            (key.clone(), item)
        })
        .collect()
}

#[tokio::test]
async fn entries_saved_before_shares_list_without_a_split() {
    let table = FakeTable::seeded(before_list_shares());
    let answer = send(&table, "carlos", "GET", "/api/expenses?limit=100", None).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    let rows = answer.body["expenses"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(row.get("splitMode"), None, "{row}");
        assert_eq!(row.get("participants"), None, "{row}");
    }
}

#[tokio::test]
async fn a_dry_run_counts_and_changes_nothing() {
    let before = before_list_shares();
    let table = FakeTable::seeded(before.clone());
    let done = list_entries(&table, true).await.unwrap();
    assert_eq!(done, expense_count(&before));
    assert_eq!(table.snapshot(), before);
}

#[tokio::test]
async fn every_entry_gets_the_split_its_expense_has() {
    let before = before_list_shares();
    let table = FakeTable::seeded(before.clone());
    let done = list_entries(&table, false).await.unwrap();
    assert_eq!(done, expense_count(&before));

    let after = table.snapshot();
    assert_eq!(
        head_rev(&after),
        head_rev(&before) + done as u64,
        "one write per expense"
    );
    // The entries now hold what the data set says entries hold, and nothing else changed.
    assert_eq!(without_revs(&after), without_revs(&base_items()));

    let answer = send(&table, "carlos", "GET", "/api/expenses?limit=100", None).await;
    let rows = answer.body["expenses"].as_array().unwrap();
    assert!(
        rows.iter().all(|row| row["participants"].is_array()),
        "{rows:?}"
    );
}

#[tokio::test]
async fn running_it_again_changes_nothing() {
    let table = FakeTable::seeded(before_list_shares());
    list_entries(&table, false).await.unwrap();
    let once = table.snapshot();
    assert_eq!(list_entries(&table, false).await.unwrap(), 0);
    assert_eq!(table.snapshot(), once);
}

#[tokio::test]
async fn entries_that_already_match_are_left_alone() {
    let before = base_items();
    let table = FakeTable::seeded(before.clone());
    assert_eq!(list_entries(&table, false).await.unwrap(), 0);
    assert_eq!(table.snapshot(), before);
}

#[tokio::test]
async fn an_expense_without_a_live_entry_stops_it_before_any_write() {
    let mut before = before_list_shares();
    let key = before
        .iter()
        .find(|((pk, _), item)| is_expense_entry(pk) && item.get("removed").is_none())
        .map(|(key, _)| key.clone())
        .unwrap();
    before.remove(&key);
    let table = FakeTable::seeded(before.clone());
    let error = list_entries(&table, false).await.unwrap_err();
    assert!(
        format!("{error:?}").contains("without a live list entry"),
        "{error:?}"
    );
    assert_eq!(table.snapshot(), before);
}

#[tokio::test]
async fn a_write_that_lands_first_makes_it_read_again() {
    let before = before_list_shares();
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
    let done = list_entries(&table, false).await.unwrap();
    assert_eq!(done, expense_count(&before));
    assert_eq!(
        head_rev(&table.snapshot()),
        head_rev(&before) + 1 + done as u64
    );
}
