//! The avatar backfill, run on the base data as it was stored before avatars existed.

mod support;

use family_ledger::service::backfill::avatars;
use family_ledger::service::profile::BACKFILL_MONKEYS;
use serde_json::Value;
use support::fake_table::FakeTable;
use support::fixtures::{base_items, before_avatars, Items};
use support::router::send;

fn head_rev(items: &Items) -> u64 {
    items[&("LEDGER#main".to_string(), "HEAD".to_string())]["rev"]
        .as_u64()
        .unwrap()
}

fn is_member((pk, sk): &(String, String)) -> bool {
    pk == "LEDGER#main" && sk.starts_with("PROFILE#")
}

fn member_count(items: &Items) -> usize {
    items.keys().filter(|key| is_member(key)).count()
}

/// The avatar of each member, in sign-up order.
fn avatars_in_sign_up_order(items: &Items) -> Vec<Option<String>> {
    let mut members: Vec<_> = items
        .iter()
        .filter(|(key, _)| is_member(key))
        .map(|((_, sk), item)| (item["createdAt"].as_str().unwrap(), sk.as_str(), item))
        .collect();
    members.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    members
        .into_iter()
        .map(|(_, _, item)| item.get("avatar").map(|a| a.as_str().unwrap().to_string()))
        .collect()
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

/// The base data with Tío Beto given the monkey the backfill hands him.
fn base_after_backfill() -> Items {
    let mut items = base_items();
    for (key, item) in items.iter_mut() {
        if is_member(key) && item["displayName"] == "Tío Beto" {
            item.insert("avatar".to_string(), Value::from("🐒"));
        }
    }
    items
}

#[tokio::test]
async fn a_member_saved_before_avatars_has_none() {
    let table = FakeTable::seeded(before_avatars());
    let answer = send(&table, "carlos", "GET", "/api/ledger", None).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    for member in answer.body["members"].as_array().unwrap() {
        assert_eq!(member["avatar"], Value::Null, "{member}");
    }
    let answer = send(&table, "carlos", "GET", "/api/me", None).await;
    assert_eq!(answer.body["avatar"], Value::Null, "{}", answer.body);
}

#[tokio::test]
async fn a_dry_run_counts_and_changes_nothing() {
    let before = before_avatars();
    let table = FakeTable::seeded(before.clone());
    let done = avatars(&table, true).await.unwrap();
    assert_eq!(done, member_count(&before));
    assert_eq!(table.snapshot(), before);
}

#[tokio::test]
async fn monkeys_go_in_sign_up_order_and_start_again_after_four() {
    let before = before_avatars();
    let table = FakeTable::seeded(before.clone());
    let done = avatars(&table, false).await.unwrap();
    assert_eq!(done, member_count(&before));

    let after = table.snapshot();
    assert_eq!(
        head_rev(&after),
        head_rev(&before) + done as u64,
        "one write per member"
    );
    let wanted: Vec<Option<String>> = (0..done)
        .map(|place| Some(BACKFILL_MONKEYS[place % 4].to_string()))
        .collect();
    assert_eq!(avatars_in_sign_up_order(&after), wanted);
    // Former members are included, and nothing else changed.
    assert_eq!(without_revs(&after), without_revs(&base_after_backfill()));

    let answer = send(&table, "carlos", "GET", "/api/ledger", None).await;
    let members = answer.body["members"].as_array().unwrap();
    assert!(
        members.iter().all(|m| m["avatar"].is_string()),
        "{members:?}"
    );
}

#[tokio::test]
async fn members_who_have_an_avatar_keep_it() {
    let before = base_items();
    let table = FakeTable::seeded(before.clone());
    // Only Tío Beto was saved before avatars.
    assert_eq!(avatars(&table, false).await.unwrap(), 1);
    assert_eq!(
        without_revs(&table.snapshot()),
        without_revs(&base_after_backfill())
    );
}

#[tokio::test]
async fn a_chosen_avatar_survives_the_backfill() {
    let table = FakeTable::seeded(before_avatars());
    let body = serde_json::json!({ "homeCurrency": "CAD", "avatar": "🦊" });
    let answer = send(&table, "carlos", "PUT", "/api/me/profile", Some(&body)).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    avatars(&table, false).await.unwrap();
    let answer = send(&table, "carlos", "GET", "/api/me", None).await;
    assert_eq!(answer.body["avatar"], "🦊");
}

#[tokio::test]
async fn running_it_again_changes_nothing() {
    let table = FakeTable::seeded(before_avatars());
    avatars(&table, false).await.unwrap();
    let once = table.snapshot();
    assert_eq!(avatars(&table, false).await.unwrap(), 0);
    assert_eq!(table.snapshot(), once);
}

#[tokio::test]
async fn a_write_that_lands_first_makes_it_read_again() {
    let before = before_avatars();
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
    let done = avatars(&table, false).await.unwrap();
    assert_eq!(done, member_count(&before));
    assert_eq!(
        head_rev(&table.snapshot()),
        head_rev(&before) + 1 + done as u64
    );
}
