//! Every case in `testdata/ledger/requests.json`, each against freshly loaded base data.

mod support;

use std::collections::HashMap;
use std::fs;

use family_ledger::model::{Expense, Payment};
use family_ledger::rules::replay::{replay_all, slices_by_year};
use serde_json::{json, Value};
use support::fake_table::FakeTable;
use support::fixtures::{base_items, data_dir, ledger_items, Items};
use support::router::send_write;

fn cases() -> Vec<Value> {
    let text = fs::read_to_string(data_dir().join("requests.json")).expect("requests.json");
    serde_json::from_str(&text).expect("the request cases")
}

/// Everything in `expected` must appear in `actual`.
fn assert_contains(actual: &Value, expected: &Value, name: &str) {
    for (field, value) in expected.as_object().expect("an object") {
        assert_eq!(actual.get(field), Some(value), "{name}: field {field}");
    }
}

fn ids(list: &Value, name: &str) -> Vec<Value> {
    list.as_array()
        .unwrap_or_else(|| panic!("{name}: no list in the answer"))
        .iter()
        .map(|row| row["id"].clone())
        .collect()
}

fn head_rev(items: &Items) -> u64 {
    items[&("LEDGER#main".to_string(), "HEAD".to_string())]["rev"]
        .as_u64()
        .unwrap()
}

/// Stored pair and allocation items must always equal a full replay.
fn assert_matches_replay(items: &Items, name: &str) {
    let expenses: Vec<Expense> = ledger_items(items, "EXPENSE#", |id, value| {
        let mut expense: Expense = serde_json::from_value(value).unwrap();
        expense.id = id.to_string();
        expense
    });
    let payments: Vec<Payment> = ledger_items(items, "PAYMENT#", |id, value| {
        let mut payment: Payment = serde_json::from_value(value).unwrap();
        payment.id = id.to_string();
        payment
    });
    let dates: HashMap<String, String> = expenses
        .iter()
        .map(|e| (e.id.clone(), e.date.clone()))
        .collect();
    let stored = |sk: String| {
        let mut item = items[&("LEDGER#main".to_string(), sk)].clone();
        for key in ["PK", "SK", "rev"] {
            item.remove(key);
        }
        Value::Object(item)
    };
    for ((low, high), history) in replay_all(&expenses, &payments).unwrap() {
        let replayed = serde_json::to_value(history.state.to_item()).unwrap();
        assert_eq!(
            stored(format!("PAIR#{low}#{high}")),
            replayed,
            "{name}: pair {low} {high}"
        );
        for (year, slices) in slices_by_year(&history.slices, &dates) {
            let replayed = json!({ "allocations": slices });
            assert_eq!(
                stored(format!("ALLOC#{low}#{high}#{year}")),
                replayed,
                "{name}: {year}"
            );
        }
    }
}

#[tokio::test]
async fn every_request_case_gets_the_answer_it_must_get() {
    let cases = cases();
    assert_eq!(
        cases.len(),
        128,
        "the data set changed, so check this runner still covers it"
    );

    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let before = base_items();
        let table = FakeTable::seeded(before.clone());
        let answer = send_write(&table, case).await;

        let expect = &case["expect"];
        assert_eq!(
            answer.status as u64,
            expect["status"].as_u64().unwrap(),
            "{name}: {}",
            answer.body
        );
        assert_eq!(
            answer.cache_control.as_deref(),
            Some("no-store"),
            "{name}: cache header"
        );
        if let Some(code) = expect.get("code") {
            assert_eq!(&answer.body["error"]["code"], code, "{name}: error code");
        }
        if let Some(body) = expect.get("body") {
            assert_contains(&answer.body, body, name);
        }
        for list in ["expenses", "payments"] {
            if let Some(wanted) = expect.get(list) {
                assert_eq!(
                    &ids(&answer.body[list], name),
                    wanted.as_array().unwrap(),
                    "{name}: {list}"
                );
                let more = !answer.body["nextCursor"].is_null();
                assert_eq!(
                    Some(more),
                    expect["morePages"].as_bool(),
                    "{name}: more pages"
                );
            }
        }

        let after = table.snapshot();
        let repeat = name.starts_with("repeating");
        if case["path"] == "/api/exchange-rates/refresh" {
            // A refresh always records its attempt in the status item, which is outside the
            // ledger, and moves the ledger only when it saves new rates.
            let ledger = |items: &Items| -> Items {
                let mut items = items.clone();
                items.remove(&("RATES".to_string(), "STATUS".to_string()));
                items
            };
            if answer.body["updated"] == json!(true) {
                assert_eq!(
                    head_rev(&after),
                    head_rev(&before) + 1,
                    "{name}: one revision"
                );
            } else {
                assert_eq!(
                    ledger(&after),
                    ledger(&before),
                    "{name}: the ledger must not change"
                );
            }
        } else if answer.status >= 400 || case["method"] == "GET" || repeat {
            assert_eq!(after, before, "{name}: this request must change nothing");
        } else if case["path"] != "/api/me/profile"
            || name.starts_with("finishing sign-up")
            || name == "changing only the avatar"
        {
            assert_eq!(
                head_rev(&after),
                head_rev(&before) + 1,
                "{name}: one write, one revision"
            );
        }
        assert_matches_replay(&after, name);
    }
}
