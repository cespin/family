//! The read and write protocols when other writes get in the way.

mod support;

use family_ledger::store::table::CancelReason;
use serde_json::{json, Map, Value};
use support::fake_table::FakeTable;
use support::fixtures::{base_items, Items};
use support::router::send;

const CARLOS: &str = "a0000000-0000-4000-8000-000000000001";
const LUCIA: &str = "a0000000-0000-4000-8000-000000000002";
const CARE: &str = "b0000000-0000-4000-8000-000000000003";
const TABLET: &str = "c0000000-0000-4000-8000-000000000012";

fn key(pk: &str, sk: &str) -> (String, String) {
    (pk.to_string(), sk.to_string())
}

fn head() -> (String, String) {
    key("LEDGER#main", "HEAD")
}

fn rev(items: &Items) -> u64 {
    items[&head()]["rev"].as_u64().unwrap()
}

fn item(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn payment(request_id: &str) -> Value {
    json!({
        "requestId": request_id,
        "fromId": CARLOS,
        "toId": LUCIA,
        "paid": { "amountMinor": 1000, "currency": "CLP" },
        "method": "transfer",
        "date": "2026-11-18",
    })
}

const REQUEST: &str = "90000000-0000-4000-8000-000000000501";

/// A write that lands between a read's first look at the head and its queries.
fn land_a_write(items: &mut Items) {
    let next = rev(items) + 1;
    let group = key("LEDGER#main", &format!("GROUP#{CARE}"));
    let mut changed = items[&group].clone();
    changed.insert("name".to_string(), json!("Nombre nuevo"));
    changed.insert("rev".to_string(), json!(next));
    items.insert(group, changed);
    let sk = format!("GROUP#{CARE}");
    items.insert(
        head(),
        item(json!({
            "PK": "LEDGER#main", "SK": "HEAD", "rev": next,
            "lastWrite": [{ "PK": "LEDGER#main", "SK": sk }],
        })),
    );
}

#[tokio::test]
async fn a_read_overtaken_by_a_write_reads_again() {
    let table = FakeTable::seeded(base_items());
    let before = rev(&table.snapshot());
    // Allowlist, account link and first head come first, so this lands during the queries.
    table.before_read(5, land_a_write);

    let answer = send(&table, "carlos", "GET", "/api/ledger", None).await;

    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(answer.body["revision"], json!(before + 1));
    let care = answer.body["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == CARE)
        .unwrap();
    assert_eq!(care["name"], "Nombre nuevo");
}

#[tokio::test]
async fn an_item_newer_than_the_head_is_never_returned() {
    let mut items = base_items();
    let group = key("LEDGER#main", &format!("GROUP#{CARE}"));
    items
        .get_mut(&group)
        .unwrap()
        .insert("rev".to_string(), json!(9999));
    let table = FakeTable::seeded(items);

    let answer = send(&table, "carlos", "GET", "/api/ledger", None).await;

    assert_eq!(answer.status, 500);
    assert_eq!(answer.body["error"]["code"], "internal_error");
    assert!(
        answer.body.get("groups").is_none(),
        "a failed read returns no partial data"
    );
}

#[tokio::test]
async fn a_write_named_by_the_head_that_has_not_landed_is_never_returned() {
    let mut items = base_items();
    let next = rev(&items);
    items.insert(
        head(),
        item(json!({
            "PK": "LEDGER#main", "SK": "HEAD", "rev": next,
            "lastWrite": [{ "PK": "LEDGER#main", "SK": "EXPENSE#c0000000-0000-4000-8000-000000009999" }],
        })),
    );
    let table = FakeTable::seeded(items);

    let answer = send(&table, "carlos", "GET", "/api/ledger", None).await;

    assert_eq!(answer.status, 500);
}

#[tokio::test]
async fn a_failed_read_is_an_error_and_never_an_empty_result() {
    let table = FakeTable::seeded(base_items());
    table.fail_from_read(5);

    let answer = send(&table, "carlos", "GET", "/api/expenses", None).await;

    assert_eq!(answer.status, 500);
    assert!(answer.body.get("expenses").is_none());
    assert_eq!(answer.cache_control.as_deref(), Some("no-store"));
}

#[tokio::test]
async fn a_table_with_no_ledger_yet_starts_at_revision_zero() {
    let mut items = Items::new();
    items.insert(
        key("MEMBER#nina@example.test", "PROFILE"),
        item(json!({ "PK": "MEMBER#nina@example.test", "SK": "PROFILE", "email": "nina@example.test" })),
    );
    let table = FakeTable::seeded(items);

    let body = json!({ "homeCurrency": "CLP", "displayName": "Nina" });
    let answer = send(&table, "nina", "PUT", "/api/me/profile", Some(&body)).await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(answer.body["displayName"], "Nina");
    assert_eq!(rev(&table.snapshot()), 1);

    let ledger = send(&table, "nina", "GET", "/api/ledger", None).await;
    assert_eq!(ledger.status, 200, "{}", ledger.body);
    assert_eq!(ledger.body["revision"], 1);
    assert_eq!(ledger.body["exchangeRates"], json!([]));
}

#[tokio::test]
async fn a_write_that_loses_a_race_tries_again_and_saves_once() {
    for reason in [CancelReason::GuardFailed, CancelReason::Conflict] {
        let table = FakeTable::seeded(base_items());
        let before = rev(&table.snapshot());
        table.cancel_next(vec![reason, CancelReason::None]);

        let answer = send(
            &table,
            "carlos",
            "POST",
            "/api/payments",
            Some(&payment(REQUEST)),
        )
        .await;

        assert_eq!(answer.status, 201, "{}", answer.body);
        assert_eq!(*table.transactions.lock().unwrap(), 2);
        assert_eq!(rev(&table.snapshot()), before + 1);
    }
}

#[tokio::test]
async fn a_write_landing_just_before_the_commit_is_never_overwritten() {
    let table = FakeTable::seeded(base_items());
    let before = rev(&table.snapshot());
    table.before_commit(land_a_write);

    let answer = send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    assert_eq!(answer.status, 201, "{}", answer.body);
    assert_eq!(
        *table.transactions.lock().unwrap(),
        2,
        "the first attempt must be refused"
    );
    let items = table.snapshot();
    assert_eq!(rev(&items), before + 2, "both writes count");
    assert_eq!(
        items[&key("LEDGER#main", &format!("GROUP#{CARE}"))]["name"],
        "Nombre nuevo"
    );
}

#[tokio::test]
async fn a_write_that_keeps_losing_answers_conflict_and_saves_nothing() {
    let items = base_items();
    let table = FakeTable::seeded(items.clone());
    for _ in 0..3 {
        table.cancel_next(vec![CancelReason::GuardFailed, CancelReason::None]);
    }

    let answer = send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    assert_eq!(answer.status, 409);
    assert_eq!(answer.body["error"]["code"], "conflict");
    assert_eq!(*table.transactions.lock().unwrap(), 3);
    assert_eq!(table.snapshot(), items);
}

#[tokio::test]
async fn removing_a_member_during_their_write_refuses_it() {
    let items = base_items();
    let table = FakeTable::seeded(items.clone());
    table.cancel_next(vec![CancelReason::None, CancelReason::GuardFailed]);

    let answer = send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    assert_eq!(answer.status, 403);
    assert_eq!(table.snapshot(), items);
}

#[tokio::test]
async fn a_retry_of_a_save_that_landed_returns_it_without_saving_again() {
    let table = FakeTable::seeded(base_items());
    let first = send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;
    let saved = rev(&table.snapshot());

    let again = send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    assert_eq!(again.status, 201);
    assert_eq!(again.body["id"], first.body["id"]);
    assert_eq!(rev(&table.snapshot()), saved);
}

#[tokio::test]
async fn another_member_cannot_read_a_saved_record_by_reusing_its_request_id() {
    let table = FakeTable::seeded(base_items());
    send(
        &table,
        "carlos",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    let answer = send(
        &table,
        "lucia",
        "POST",
        "/api/payments",
        Some(&payment(REQUEST)),
    )
    .await;

    assert_eq!(answer.status, 409);
    assert!(answer.body.get("paid").is_none());
}

#[tokio::test]
async fn losing_the_race_to_finish_signing_up_never_makes_two_members() {
    let mut items = base_items();
    items.remove(&key("ACCOUNT#nina@example.test", "LINK"));
    let table = FakeTable::seeded(items);
    let winner = "a0000000-0000-4000-8000-000000000777";

    table.cancel_next(vec![
        CancelReason::None,
        CancelReason::None,
        CancelReason::None,
        CancelReason::GuardFailed,
    ]);
    table.before_read(4, move |items| {
        items.insert(
            key("ACCOUNT#nina@example.test", "LINK"),
            item(json!({ "PK": "ACCOUNT#nina@example.test", "SK": "LINK", "memberId": winner })),
        );
        let sk = format!("PROFILE#{winner}");
        items.insert(
            key("LEDGER#main", &sk),
            item(json!({
                "PK": "LEDGER#main", "SK": sk, "displayName": "Nina", "homeCurrency": "CLP",
                "email": "nina@example.test", "createdAt": "2026-11-18T12:00:00Z", "rev": 55,
            })),
        );
    });

    let body = json!({ "homeCurrency": "USD", "displayName": "Otra Nina" });
    let answer = send(&table, "nina", "PUT", "/api/me/profile", Some(&body)).await;

    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(answer.body["memberId"], winner);
    assert_eq!(answer.body["displayName"], "Nina");
    assert_eq!(answer.body["homeCurrency"], "USD");
}

#[tokio::test]
async fn a_removed_member_is_refused_despite_a_valid_token() {
    let table = FakeTable::seeded(base_items());
    let answer = send(&table, "rosa", "GET", "/api/me", None).await;
    assert_eq!(answer.status, 403);
    assert_eq!(answer.cache_control.as_deref(), Some("no-store"));
}

#[tokio::test]
async fn a_cursor_only_works_with_the_filters_that_produced_it() {
    let table = FakeTable::seeded(base_items());
    let first = send(&table, "carlos", "GET", "/api/expenses?limit=1", None).await;
    let cursor = first.body["nextCursor"].as_str().unwrap().to_string();

    let path = format!("/api/expenses?limit=1&kind=meal&cursor={cursor}");
    let answer = send(&table, "carlos", "GET", &path, None).await;

    assert_eq!(answer.status, 400);
    assert_eq!(answer.body["error"]["code"], "validation_error");
}

#[tokio::test]
async fn the_detail_of_a_purchase_shows_both_amounts() {
    let table = FakeTable::seeded(base_items());
    let id = "c0000000-0000-4000-8000-000000000014";

    let answer = send(&table, "lucia", "GET", &format!("/api/expenses/{id}"), None).await;

    assert_eq!(
        answer.body["otherAmount"],
        json!({ "amountMinor": 120000, "currency": "CLP" })
    );
    assert_eq!(answer.body["chargedCurrency"], "CAD");
    let shares: Vec<&Value> = answer.body["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| &row["otherShareMinor"])
        .collect();
    assert_eq!(shares, [&json!(60000), &json!(30000), &json!(30000)]);
}

#[tokio::test]
async fn an_edit_with_the_same_request_id_is_answered_from_what_was_saved() {
    let table = FakeTable::seeded(base_items());
    let path = format!("/api/expenses/{TABLET}");
    let current = send(&table, "carlos", "GET", &path, None).await.body;
    let body = json!({
        "requestId": "90000000-0000-4000-8000-000000000601",
        "title": "Tablet nueva",
        "kind": current["kind"],
        "groupId": current["groupId"],
        "payerId": current["payerId"],
        "amountMinor": current["amountMinor"],
        "currency": current["currency"],
        "splitMode": "percent",
        "participantIds": [CARLOS, LUCIA, "a0000000-0000-4000-8000-000000000003"],
        "percents": { CARLOS: 50, LUCIA: 25, "a0000000-0000-4000-8000-000000000003": 25 },
        "version": current["version"],
    });

    let first = send(&table, "carlos", "PUT", &path, Some(&body)).await;
    assert_eq!(first.status, 200, "{}", first.body);
    let saved = rev(&table.snapshot());

    let again = send(&table, "carlos", "PUT", &path, Some(&body)).await;
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(again.body["title"], "Tablet nueva");
    assert_eq!(rev(&table.snapshot()), saved);
}
