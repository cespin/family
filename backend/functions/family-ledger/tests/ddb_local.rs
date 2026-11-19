//! The ledger on a real DynamoDB engine. Run through `scripts/test-ddb-local.sh`, because
//! `cargo test --workspace` must pass with nothing running.

mod support;

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use aws_sdk_dynamodb::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_dynamodb::types::{
    AttributeDefinition, BillingMode, KeySchemaElement, KeyType, ScalarAttributeType,
};
use aws_sdk_dynamodb::Client;
use family_ledger::store::dynamo::DynamoTable;
use family_ledger::store::table::{
    CancelReason, Guard, Item, Key, PageQuery, Table, TxOp, TxOutcome,
};
use serde_json::{json, Value};
use support::fixtures::{base_items, data_dir, scenario_items, Items};
use support::router::send;

static TABLES: AtomicUsize = AtomicUsize::new(0);

/// Refuses anything but a local endpoint, so these tests can never touch a real table.
fn client() -> Client {
    let endpoint = std::env::var("DDB_LOCAL_ENDPOINT")
        .expect("DDB_LOCAL_ENDPOINT is not set: use scripts/test-ddb-local.sh");
    assert!(
        endpoint.starts_with("http://localhost:") || endpoint.starts_with("http://127.0.0.1:"),
        "DDB_LOCAL_ENDPOINT must be a loopback address"
    );
    let config = aws_sdk_dynamodb::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(endpoint)
        .region(Region::new("local"))
        .credentials_provider(Credentials::new(
            "fake",
            "fake",
            None,
            None,
            "ddb-local-tests",
        ))
        .build();
    Client::from_conf(config)
}

async fn new_table() -> DynamoTable {
    let client = client();
    let number = TABLES.fetch_add(1, Ordering::Relaxed);
    let name = format!("test-{}-{number}", std::process::id());
    let attribute = |name: &str| {
        AttributeDefinition::builder()
            .attribute_name(name)
            .attribute_type(ScalarAttributeType::S)
            .build()
            .unwrap()
    };
    let key = |name: &str, kind| {
        KeySchemaElement::builder()
            .attribute_name(name)
            .key_type(kind)
            .build()
            .unwrap()
    };
    client
        .create_table()
        .table_name(&name)
        .billing_mode(BillingMode::PayPerRequest)
        .attribute_definitions(attribute("PK"))
        .attribute_definitions(attribute("SK"))
        .key_schema(key("PK", KeyType::Hash))
        .key_schema(key("SK", KeyType::Range))
        .send()
        .await
        .expect("the test table is created");
    DynamoTable::new(client, name)
}

async fn seeded(items: &Items) -> DynamoTable {
    let table = new_table().await;
    let all: Vec<Item> = items.values().cloned().collect();
    for chunk in all.chunks(100) {
        let ops = chunk.iter().map(|item| TxOp::Put {
            item: item.clone(),
            guard: Guard::None,
        });
        assert_eq!(
            table.transact(ops.collect()).await.unwrap(),
            TxOutcome::Committed
        );
    }
    table
}

fn item(pk: &str, sk: &str, rev: u64) -> Item {
    json!({ "PK": pk, "SK": sk, "rev": rev, "nested": { "list": [1, "two", true] } })
        .as_object()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn every_fixture_item_round_trips_unchanged() {
    let items = base_items();
    let table = seeded(&items).await;
    for ((pk, sk), expected) in &items {
        let found = table.get(&Key::new(pk, sk)).await.unwrap();
        assert_eq!(found.as_ref(), Some(expected), "{pk} {sk}");
    }
}

#[tokio::test]
async fn a_batch_read_returns_every_item_past_the_page_limit() {
    let table = new_table().await;
    let items: Vec<Item> = (0..230)
        .map(|n| item("BATCH", &format!("{n:04}"), 1))
        .collect();
    for chunk in items.chunks(100) {
        let ops = chunk.iter().map(|i| TxOp::Put {
            item: i.clone(),
            guard: Guard::None,
        });
        table.transact(ops.collect()).await.unwrap();
    }
    let keys: Vec<Key> = items.iter().map(|i| Key::of(i).unwrap()).collect();
    assert_eq!(table.batch_get(&keys).await.unwrap().len(), 230);
}

#[tokio::test]
async fn queries_page_in_both_directions_and_respect_their_bounds() {
    let table = new_table().await;
    let ops = (0..7).map(|n| TxOp::Put {
        item: item("LIST", &format!("a#{n}"), 1),
        guard: Guard::None,
    });
    table.transact(ops.collect()).await.unwrap();
    let sort_keys = |items: &[Item]| -> Vec<String> {
        items
            .iter()
            .map(|i| i["SK"].as_str().unwrap().to_string())
            .collect()
    };

    let query = PageQuery {
        pk: "LIST".to_string(),
        before: Some("a#5".to_string()),
        descending: true,
        limit: Some(2),
        ..PageQuery::default()
    };
    let first = table.query_page(&query).await.unwrap();
    assert_eq!(sort_keys(&first.items), ["a#4", "a#3"]);
    let second = PageQuery {
        start_after: first.next,
        ..query
    };
    assert_eq!(
        sort_keys(&table.query_page(&second).await.unwrap().items),
        ["a#2", "a#1"]
    );

    let prefix = PageQuery {
        pk: "LIST".to_string(),
        prefix: Some("a#6".to_string()),
        ..PageQuery::default()
    };
    assert_eq!(
        sort_keys(&table.query_page(&prefix).await.unwrap().items),
        ["a#6"]
    );
}

#[tokio::test]
async fn guards_cancel_a_transaction_and_name_the_failed_action() {
    let table = new_table().await;
    let put = |item, guard| TxOp::Put { item, guard };
    let first = vec![
        put(item("G", "head", 3), Guard::Rev(0)),
        put(item("G", "one", 1), Guard::Absent),
    ];
    assert_eq!(table.transact(first).await.unwrap(), TxOutcome::Committed);

    let stale = vec![
        put(item("G", "head", 4), Guard::Rev(2)),
        put(item("G", "two", 1), Guard::None),
    ];
    assert_eq!(
        table.transact(stale).await.unwrap(),
        TxOutcome::Cancelled(vec![CancelReason::GuardFailed, CancelReason::None])
    );
    assert_eq!(table.get(&Key::new("G", "two")).await.unwrap(), None);

    let missing = vec![
        put(item("G", "head", 4), Guard::Rev(3)),
        TxOp::Check {
            key: Key::new("G", "nobody"),
            guard: Guard::Exists,
        },
    ];
    assert_eq!(
        table.transact(missing).await.unwrap(),
        TxOutcome::Cancelled(vec![CancelReason::None, CancelReason::GuardFailed])
    );

    let current = vec![
        put(item("G", "head", 4), Guard::Rev(3)),
        TxOp::Check {
            key: Key::new("G", "one"),
            guard: Guard::Exists,
        },
    ];
    assert_eq!(table.transact(current).await.unwrap(), TxOutcome::Committed);
}

async fn all_items(table: &DynamoTable, reference: &Items) -> Items {
    let mut found = Items::new();
    for (pk, sk) in reference.keys() {
        if let Some(item) = table.get(&Key::new(pk, sk)).await.unwrap() {
            found.insert((pk.clone(), sk.clone()), item);
        }
    }
    found
}

fn without_times(items: &Items) -> Items {
    items
        .iter()
        .map(|(key, item)| {
            let mut item = item.clone();
            item.remove("recordedAt");
            item.remove("createdAt");
            if key.1 == "HEAD" {
                let mut written: Vec<String> = item["lastWrite"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(Value::to_string)
                    .collect();
                written.sort();
                item.insert("lastWrite".to_string(), json!(written));
            }
            (key.clone(), item)
        })
        .collect()
}

#[tokio::test]
async fn each_scenarios_writes_store_exactly_what_the_data_set_says() {
    let text = fs::read_to_string(data_dir().join("expected.json")).unwrap();
    let expected: Value = serde_json::from_str(&text).unwrap();
    for scenario in expected["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let table = seeded(&base_items()).await;
        for write in scenario["writes"].as_array().unwrap() {
            let answer = send(
                &table,
                write["caller"].as_str().unwrap(),
                write["method"].as_str().unwrap(),
                write["path"].as_str().unwrap(),
                Some(&write["body"]),
            )
            .await;
            assert!(answer.status < 300, "{name}: {}", answer.body);
        }
        let wanted = scenario_items(name);
        let actual = all_items(&table, &wanted).await;
        assert_eq!(without_times(&actual), without_times(&wanted), "{name}");
    }
}

fn payment_body(request_id: &str, amount_minor: u64) -> Value {
    json!({
        "requestId": request_id,
        "fromId": "a0000000-0000-4000-8000-000000000001",
        "toId": "a0000000-0000-4000-8000-000000000002",
        "paid": { "amountMinor": amount_minor, "currency": "CLP" },
        "method": "transfer",
        "date": "2026-11-18",
    })
}

async fn head_rev(table: &DynamoTable) -> u64 {
    let head = table
        .get(&Key::new("LEDGER#main", "HEAD"))
        .await
        .unwrap()
        .unwrap();
    head["rev"].as_u64().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_payments_lose_no_update() {
    let table = Arc::new(seeded(&base_items()).await);
    let before = head_rev(&table).await;

    let mut tasks = Vec::new();
    for number in 0..8u64 {
        let table = Arc::clone(&table);
        tasks.push(tokio::spawn(async move {
            let id = format!("90000000-0000-4000-8000-{:012}", 700 + number);
            let body = payment_body(&id, 100 + number);
            (
                id,
                send(&*table, "carlos", "POST", "/api/payments", Some(&body))
                    .await
                    .status,
            )
        }));
    }
    let mut saved = Vec::new();
    for task in tasks {
        let (id, status) = task.await.unwrap();
        assert!(status == 201 || status == 409, "unexpected status {status}");
        if status == 201 {
            saved.push(id);
        }
    }

    assert!(!saved.is_empty(), "at least one write must land");
    assert_eq!(
        head_rev(&table).await,
        before + saved.len() as u64,
        "one revision per saved write"
    );
    for id in &saved {
        let key = Key::new("LEDGER#main", format!("PAYMENT#{id}"));
        assert!(
            table.get(&key).await.unwrap().is_some(),
            "payment {id} was lost"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_retries_of_one_request_save_one_record() {
    let table = Arc::new(seeded(&base_items()).await);
    let before = head_rev(&table).await;
    let id = "90000000-0000-4000-8000-000000000800";

    let mut tasks = Vec::new();
    for _ in 0..6 {
        let table = Arc::clone(&table);
        tasks.push(tokio::spawn(async move {
            let body = payment_body(id, 500);
            send(&*table, "carlos", "POST", "/api/payments", Some(&body))
                .await
                .status
        }));
    }
    for task in tasks {
        let status = task.await.unwrap();
        assert!(status == 201 || status == 409, "unexpected status {status}");
    }
    assert_eq!(
        head_rev(&table).await,
        before + 1,
        "the payment must be recorded once"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_sign_ins_make_one_member() {
    let table = Arc::new(seeded(&base_items()).await);

    let mut tasks = Vec::new();
    for _ in 0..5 {
        let table = Arc::clone(&table);
        tasks.push(tokio::spawn(async move {
            let body = json!({ "homeCurrency": "CLP", "displayName": "Nina" });
            send(&*table, "nina", "PUT", "/api/me/profile", Some(&body)).await
        }));
    }
    let mut members = std::collections::BTreeSet::new();
    for task in tasks {
        let answer = task.await.unwrap();
        assert!(
            answer.status == 200 || answer.status == 409,
            "{}",
            answer.body
        );
        if answer.status == 200 {
            members.insert(answer.body["memberId"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(
        members.len(),
        1,
        "one person must never become two members: {members:?}"
    );
}
