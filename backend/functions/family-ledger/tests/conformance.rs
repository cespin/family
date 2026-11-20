//! What each caller must see in `expected.json`, and what each scenario's writes must store.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use serde_json::{json, Value};
use support::fake_table::FakeTable;
use support::fixtures::{base_items, data_dir, scenario_items, Items};
use support::router::send;

fn expected() -> Value {
    let text = fs::read_to_string(data_dir().join("expected.json")).expect("expected.json");
    serde_json::from_str(&text).expect("the expected results")
}

/// Identifier to alias, across members, groups, expenses, payments and rates.
fn aliases(expected: &Value) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for ids in expected["ids"].as_object().unwrap().values() {
        for (alias, id) in ids.as_object().unwrap() {
            names.insert(id.as_str().unwrap().to_string(), alias.clone());
        }
    }
    names
}

fn alias(names: &BTreeMap<String, String>, id: &Value) -> Value {
    match id.as_str() {
        Some(id) => json!(names.get(id).unwrap_or_else(|| panic!("no alias for {id}"))),
        None => Value::Null,
    }
}

async fn all_expense_pages(table: &FakeTable, caller: &str, filter: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let after = cursor.map_or(String::new(), |cursor| format!("&cursor={cursor}"));
        let path = format!("/api/expenses?limit=3{filter}{after}");
        let answer = send(table, caller, "GET", &path, None).await;
        assert_eq!(answer.status, 200, "{path}: {}", answer.body);
        rows.extend(answer.body["expenses"].as_array().unwrap().iter().cloned());
        match answer.body["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => return rows,
        }
    }
}

async fn check_caller(table: &FakeTable, caller: &str, view: &Value, expected: &Value, set: &str) {
    let names = aliases(expected);
    let group_id = |group: &str| {
        expected["ids"]["group"][group]
            .as_str()
            .unwrap()
            .to_string()
    };
    let label = format!("{set}, {caller}");

    let ledger = send(table, caller, "GET", "/api/ledger", None).await;
    if view["access"] == "forbidden" {
        assert_eq!(ledger.status, 403, "{label}");
        return;
    }
    assert_eq!(ledger.status, 200, "{label}: {}", ledger.body);
    assert_eq!(ledger.body["me"], view["memberId"], "{label}: who");

    let groups: BTreeSet<String> = ledger.body["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| alias(&names, &g["id"]).to_string())
        .collect();
    let wanted: BTreeSet<String> = view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(Value::to_string)
        .collect();
    assert_eq!(groups, wanted, "{label}: groups");

    // The order of rows and of amounts inside them is not part of the contract.
    let normal = |amounts: &Value| -> BTreeSet<String> {
        amounts
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.to_string())
            .collect()
    };
    let standings = ledger.body["standings"].as_array().unwrap();
    let wanted = view["standings"].as_array().unwrap();
    assert_eq!(standings.len(), wanted.len(), "{label}: standings");
    for row in wanted {
        let found = standings
            .iter()
            .find(|s| alias(&names, &s["memberId"]) == row["member"])
            .unwrap_or_else(|| panic!("{label}: no standing with {}", row["member"]));
        assert_eq!(
            normal(&found["overall"]),
            normal(&row["overall"]),
            "{label}: overall"
        );
        for group in row["groups"].as_array().unwrap() {
            let actual = found["groups"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| alias(&names, &g["groupId"]) == group["group"])
                .unwrap_or_else(|| panic!("{label}: no group {}", group["group"]));
            assert_eq!(
                normal(&actual["amounts"]),
                normal(&group["amounts"]),
                "{label}: group"
            );
        }
    }

    let listed =
        |rows: Vec<Value>| -> Vec<Value> { rows.iter().map(|r| alias(&names, &r["id"])).collect() };
    let every_row = all_expense_pages(table, caller, "").await;
    let all = listed(every_row.clone());
    assert_eq!(&json!(all), &view["lists"]["all"], "{label}: every expense");
    for (group, wanted) in view["lists"]["byGroup"].as_object().unwrap() {
        let filter = format!("&groupId={}", group_id(group));
        let rows = listed(all_expense_pages(table, caller, &filter).await);
        assert_eq!(&json!(rows), wanted, "{label}: group {group}");
    }
    for (kind, wanted) in view["lists"]["byKind"].as_object().unwrap() {
        let rows = listed(all_expense_pages(table, caller, &format!("&kind={kind}")).await);
        assert_eq!(&json!(rows), wanted, "{label}: kind {kind}");
    }

    let payments = send(table, caller, "GET", "/api/payments?limit=100", None).await;
    let rows: Vec<Value> = payments.body["payments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| alias(&names, &p["id"]))
        .collect();
    assert_eq!(&json!(rows), &view["payments"], "{label}: payments");

    for row in view["expenses"].as_array().unwrap() {
        let name = row["expense"].as_str().unwrap();
        let id = expected["ids"]["expense"][name].as_str().unwrap();
        let answer = send(table, caller, "GET", &format!("/api/expenses/{id}"), None).await;
        let body = &answer.body;
        assert_eq!(answer.status, 200, "{label}: {name}: {body}");
        assert_eq!(
            body["standing"], row["standing"],
            "{label}: {name}: standing"
        );
        assert_eq!(
            alias(&names, &body["ratesId"]),
            row["ratesEntry"],
            "{label}: {name}: rates"
        );
        for participant in body["participants"].as_array().unwrap() {
            let who = alias(&names, &participant["memberId"]);
            let who = who.as_str().unwrap();
            assert_eq!(
                participant["status"], row["participants"][who],
                "{label}: {name}: {who}"
            );
            assert_eq!(
                participant["shareMinor"], row["shares"][who],
                "{label}: {name}: {who}"
            );
        }
        // The list shows the same split as the detail, without the payment status.
        if let Some(listed) = every_row.iter().find(|r| r["id"] == json!(id)) {
            assert_eq!(
                listed["splitMode"], body["splitMode"],
                "{label}: {name}: listed split mode"
            );
            let parts: Vec<Value> = body["participants"]
                .as_array()
                .unwrap()
                .iter()
                .map(|participant| {
                    let mut part = json!({
                        "memberId": participant["memberId"],
                        "shareMinor": participant["shareMinor"],
                    });
                    if let Some(percent) = participant.get("percent") {
                        part["percent"] = percent.clone();
                    }
                    part
                })
                .collect();
            assert_eq!(
                listed["participants"],
                json!(parts),
                "{label}: {name}: listed participants"
            );
        }
        let applied: Vec<Value> = body["appliedPayments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|slice| {
                json!({
                    "payment": alias(&names, &slice["paymentId"]),
                    "from": alias(&names, &slice["fromId"]),
                    "to": alias(&names, &slice["toId"]),
                    "paidMinor": slice["paidMinor"],
                    "paidCurrency": slice["paidCurrency"],
                    "coveredMinor": slice["coveredMinor"],
                    "method": slice["method"],
                    "date": slice["date"],
                    "transactionDate": slice["transactionDate"],
                })
            })
            .collect();
        assert_eq!(
            &json!(applied),
            &row["appliedPayments"],
            "{label}: {name}: payments"
        );
    }
}

#[tokio::test]
async fn every_caller_sees_what_the_base_data_says() {
    let expected = expected();
    let table = FakeTable::seeded(base_items());
    for (caller, view) in expected["callers"].as_object().unwrap() {
        check_caller(&table, caller, view, &expected, "base").await;
    }
}

#[tokio::test]
async fn every_scenario_shows_each_caller_the_right_figures() {
    let expected = expected();
    for scenario in expected["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let table = FakeTable::seeded(scenario_items(name));
        check_caller(
            &table,
            "carlos",
            &scenario["carlos"],
            &expected_for(&expected, scenario),
            name,
        )
        .await;
        for (caller, view) in scenario["otherCallers"].as_object().unwrap() {
            check_caller(
                &table,
                caller,
                view,
                &expected_for(&expected, scenario),
                name,
            )
            .await;
        }
    }
}

/// Scenarios add identifiers that the top-level `ids` section does not list.
fn expected_for(expected: &Value, scenario: &Value) -> Value {
    let mut merged = expected.clone();
    merged["ids"] = scenario["ids"].clone();
    merged
}

/// Fields a real clock fills in, which the data set stamps with made-up times.
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
    let expected = expected();
    for scenario in expected["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let table = FakeTable::seeded(base_items());
        for write in scenario["writes"].as_array().unwrap() {
            let answer = send(
                &table,
                write["caller"].as_str().unwrap(),
                write["method"].as_str().unwrap(),
                write["path"].as_str().unwrap(),
                Some(&write["body"]),
            )
            .await;
            assert!(
                answer.status < 300,
                "{name}: {} {}",
                write["path"],
                answer.body
            );
        }
        let (actual, wanted) = (
            without_times(&table.snapshot()),
            without_times(&scenario_items(name)),
        );
        for (key, item) in &wanted {
            assert_eq!(actual.get(key), Some(item), "{name}: item {key:?}");
        }
        let extra: Vec<_> = actual
            .keys()
            .filter(|key| !wanted.contains_key(*key))
            .collect();
        assert!(extra.is_empty(), "{name}: unexpected items {extra:?}");
    }
}
