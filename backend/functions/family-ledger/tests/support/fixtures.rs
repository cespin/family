use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

pub fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/ledger")
}

/// Turns one typed attribute into its plain value.
pub fn plain(typed: &Value) -> Value {
    let object = typed.as_object().expect("a typed attribute");
    let (kind, value) = object.iter().next().expect("a typed attribute");
    match kind.as_str() {
        "S" | "BOOL" => value.clone(),
        "N" => Value::from(
            value
                .as_str()
                .unwrap()
                .parse::<i64>()
                .expect("a whole number"),
        ),
        "L" => Value::Array(value.as_array().unwrap().iter().map(plain).collect()),
        "M" => Value::Object(
            value
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), plain(v)))
                .collect(),
        ),
        other => panic!("unexpected attribute type {other}"),
    }
}

pub type Items = BTreeMap<(String, String), Map<String, Value>>;

fn load_into(items: &mut Items, file: PathBuf) {
    let text = fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let typed: Map<String, Value> = serde_json::from_str(line).expect("a typed item");
        let item: Map<String, Value> = typed.iter().map(|(k, v)| (k.clone(), plain(v))).collect();
        let key = (
            item["PK"].as_str().unwrap().to_string(),
            item["SK"].as_str().unwrap().to_string(),
        );
        items.insert(key, item);
    }
}

pub fn base_items() -> Items {
    let mut items = Items::new();
    load_into(&mut items, data_dir().join("items.jsonl"));
    items
}

pub fn scenario_names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(data_dir().join("scenarios"))
        .expect("the scenarios folder")
        .map(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .replace(".jsonl", "")
        })
        .collect();
    names.sort();
    names
}

pub fn scenario_items(name: &str) -> Items {
    let mut items = base_items();
    load_into(
        &mut items,
        data_dir().join("scenarios").join(format!("{name}.jsonl")),
    );
    items
}

/// Every data set: the base data and each scenario on top of it.
pub fn all_data_sets() -> Vec<(String, Items)> {
    let mut sets = vec![("base".to_string(), base_items())];
    sets.extend(scenario_names().into_iter().map(|name| {
        let items = scenario_items(&name);
        (name, items)
    }));
    sets
}

/// The ledger items whose sort key starts with `prefix`, with their identifier filled in by `read`.
pub fn ledger_items<T>(items: &Items, prefix: &str, read: impl Fn(&str, Value) -> T) -> Vec<T> {
    items
        .iter()
        .filter(|((pk, sk), _)| pk == "LEDGER#main" && sk.starts_with(prefix))
        .map(|((_, sk), item)| read(&sk[prefix.len()..], Value::Object(item.clone())))
        .collect()
}
