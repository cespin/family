//! API Gateway only reads the OpenAPI document when it is deployed, so these tests pin the template
//! to the routes and request bodies the handlers really use.

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use serde_json::Value;
use support::fixtures::data_dir;

const TEMPLATE: &str = include_str!("../../../templates/api/stack.yaml");
const CONFIG: &str = include_str!("../../../config/api/stack.yaml");
const BUILD_SCRIPT: &str = include_str!("../../../scripts/build-functions.sh");

/// Every ledger route: method, path, resource name, crate and request schema.
const ROUTES: [(&str, &str, &str, &str, Option<&str>); 12] = [
    (
        "put",
        "/api/me/profile",
        "MeProfilePut",
        "me-profile-put",
        Some("ProfileRequest"),
    ),
    ("get", "/api/ledger", "LedgerRead", "ledger-read", None),
    ("get", "/api/expenses", "LedgerRead", "ledger-read", None),
    (
        "post",
        "/api/expenses",
        "ExpensesWrite",
        "expenses-write",
        Some("NewExpenseRequest"),
    ),
    (
        "get",
        "/api/expenses/{expenseId}",
        "LedgerRead",
        "ledger-read",
        None,
    ),
    (
        "put",
        "/api/expenses/{expenseId}",
        "ExpensesWrite",
        "expenses-write",
        Some("ExpenseEditRequest"),
    ),
    ("get", "/api/payments", "LedgerRead", "ledger-read", None),
    (
        "post",
        "/api/payments",
        "PaymentsPost",
        "payments-post",
        Some("PaymentRequest"),
    ),
    (
        "put",
        "/api/payments/{paymentId}",
        "PaymentsPost",
        "payments-post",
        Some("PaymentEditRequest"),
    ),
    (
        "post",
        "/api/groups",
        "GroupsWrite",
        "groups-write",
        Some("NewGroupRequest"),
    ),
    (
        "put",
        "/api/groups/{groupId}",
        "GroupsWrite",
        "groups-write",
        Some("GroupEditRequest"),
    ),
    (
        "post",
        "/api/exchange-rates/refresh",
        "ExchangeRatesRefresh",
        "exchange-rates-refresh",
        None,
    ),
];

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

#[derive(Debug, Default)]
struct Operation {
    function: String,
    schema: Option<String>,
    secured: bool,
}

/// The operations in the OpenAPI document, by method and path.
fn operations() -> BTreeMap<(String, String), Operation> {
    let mut found = BTreeMap::new();
    let (mut path, mut method) = (String::new(), String::new());
    let lines = TEMPLATE
        .lines()
        .skip_while(|line| *line != "        paths:")
        .skip(1);
    for line in lines.take_while(|line| !line.trim().is_empty()) {
        let text = line.trim();
        match indent(line) {
            10 => path = text.trim_end_matches(':').to_string(),
            12 => {
                method = text.trim_end_matches(':').to_string();
                found.insert((method.clone(), path.clone()), Operation::default());
            }
            _ => {
                let operation = found.get_mut(&(method.clone(), path.clone())).unwrap();
                if let Some(reference) = text.strip_prefix("$ref: '#/components/schemas/") {
                    operation.schema = Some(reference.trim_end_matches('\'').to_string());
                }
                if text.starts_with("- CognitoUserPool") {
                    operation.secured = true;
                }
                if let Some((_, rest)) = text.split_once("/functions/${") {
                    operation.function = rest.split("Function.Arn").next().unwrap().to_string();
                }
            }
        }
    }
    found
}

#[derive(Debug, Default)]
struct Schema {
    closed: bool,
    required: BTreeSet<String>,
    properties: BTreeSet<String>,
}

/// The top level of each request schema.
fn schemas() -> BTreeMap<String, Schema> {
    let mut found: BTreeMap<String, Schema> = BTreeMap::new();
    let (mut name, mut section) = (String::new(), String::new());
    let lines = TEMPLATE
        .lines()
        .skip_while(|line| *line != "          schemas:")
        .skip(1);
    for line in lines.take_while(|line| *line != "        paths:") {
        let text = line.trim();
        match indent(line) {
            12 => {
                name = text.trim_end_matches(':').to_string();
                found.insert(name.clone(), Schema::default());
            }
            14 => {
                section = text.trim_end_matches(':').to_string();
                if text == "additionalProperties: false" {
                    found.get_mut(&name).unwrap().closed = true;
                }
            }
            16 if section == "required" => {
                let field = text.trim_start_matches("- ").to_string();
                found.get_mut(&name).unwrap().required.insert(field);
            }
            16 if section == "properties" => {
                let field = text.trim_end_matches(':').to_string();
                found.get_mut(&name).unwrap().properties.insert(field);
            }
            _ => {}
        }
    }
    found
}

#[test]
fn every_route_reaches_its_function_behind_the_authorizer() {
    let operations = operations();
    for (method, path, function, _, schema) in ROUTES {
        let operation = operations
            .get(&(method.to_string(), path.to_string()))
            .unwrap_or_else(|| panic!("{method} {path} is not in the template"));
        assert_eq!(operation.function, function, "{method} {path}");
        assert!(operation.secured, "{method} {path} has no authorizer");
        assert_eq!(operation.schema.as_deref(), schema, "{method} {path}");
    }
}

#[test]
fn every_route_may_invoke_its_function() {
    for (method, path, function, _, _) in ROUTES {
        let route = path
            .split('/')
            .map(|part| if part.starts_with('{') { "*" } else { part })
            .collect::<Vec<_>>()
            .join("/");
        let source = format!("${{RestApi}}/*/{}{route}'", method.to_uppercase());
        let block = TEMPLATE
            .split("Type: AWS::Lambda::Permission")
            .find(|block| block.lines().take(6).any(|line| line.ends_with(&source)))
            .unwrap_or_else(|| panic!("no permission for {method} {path}"));
        assert!(
            block.contains(&format!("!Ref {function}Function")),
            "{method} {path}"
        );
    }
}

#[test]
fn every_function_is_built_and_passed_to_the_stack() {
    for (_, _, function, name, _) in ROUTES {
        assert!(
            BUILD_SCRIPT.contains(name),
            "{name} is missing from FUNCTIONS"
        );
        let variable = name.replace('-', "_");
        let parameter = format!(
            "{function}CodeS3Key: lambda/{name}/{{{{ var.code_{variable} }}}}/bootstrap.zip"
        );
        assert!(
            CONFIG.contains(&parameter),
            "{name} is missing from config/api/stack.yaml"
        );
        assert!(
            TEMPLATE.contains(&format!("{function}CodeS3Key:\n    Type: String")),
            "{name}"
        );
        assert!(
            TEMPLATE.contains(&format!("/aws/lambda/${{StackName}}-${{Salt}}-{name}")),
            "{name}"
        );
    }
}

#[test]
fn request_schemas_refuse_unknown_fields() {
    for (name, schema) in schemas() {
        assert!(schema.closed, "{name} must set additionalProperties: false");
    }
}

fn schema_of(method: &str, path: &str) -> Option<&'static str> {
    let route: Vec<&str> = path.split('?').next().unwrap().split('/').collect();
    ROUTES
        .iter()
        .find(|(candidate, pattern, ..)| {
            let pattern: Vec<&str> = pattern.split('/').collect();
            candidate.eq_ignore_ascii_case(method)
                && pattern.len() == route.len()
                && pattern
                    .iter()
                    .zip(&route)
                    .all(|(a, b)| a.starts_with('{') || a == b)
        })
        .and_then(|route| route.4)
}

fn assert_fits(
    schemas: &BTreeMap<String, Schema>,
    method: &str,
    path: &str,
    body: &Value,
    name: &str,
) {
    let Some(schema) = schema_of(method, path) else {
        return;
    };
    let schema = &schemas[schema];
    let fields: BTreeSet<String> = body.as_object().unwrap().keys().cloned().collect();
    assert!(
        schema.required.is_subset(&fields),
        "{name}: a required field is missing"
    );
    assert!(
        fields.is_subset(&schema.properties),
        "{name}: the gateway would refuse a field"
    );
}

/// A body the handlers accept must get past the gateway first.
#[test]
fn the_gateway_accepts_every_body_the_handlers_accept() {
    let schemas = schemas();
    let read = |file: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(data_dir().join(file)).unwrap()).unwrap()
    };
    for case in read("requests.json").as_array().unwrap() {
        if case["expect"]["status"].as_u64().unwrap() < 300 && case.get("body").is_some() {
            let (method, path) = (
                case["method"].as_str().unwrap(),
                case["path"].as_str().unwrap(),
            );
            assert_fits(
                &schemas,
                method,
                path,
                &case["body"],
                case["name"].as_str().unwrap(),
            );
        }
    }
    for scenario in read("expected.json")["scenarios"].as_array().unwrap() {
        for write in scenario["writes"].as_array().unwrap() {
            let (method, path) = (
                write["method"].as_str().unwrap(),
                write["path"].as_str().unwrap(),
            );
            assert_fits(
                &schemas,
                method,
                path,
                &write["body"],
                scenario["name"].as_str().unwrap(),
            );
        }
    }
}

/// The background rate update has no route, so the checks above do not reach it.
#[test]
fn the_rate_update_is_built_passed_and_only_started_by_ledger_reads() {
    assert!(BUILD_SCRIPT.contains("exchange-rates-update"));
    assert!(CONFIG.contains(
        "ExchangeRatesUpdateCodeS3Key: lambda/exchange-rates-update/{{ var.code_exchange_rates_update }}/bootstrap.zip"
    ));
    assert!(TEMPLATE.contains("/aws/lambda/${StackName}-${Salt}-exchange-rates-update"));
    assert!(TEMPLATE.contains("RATES_UPDATE_FUNCTION: !Ref ExchangeRatesUpdateFunction"));

    let role = TEMPLATE
        .split("\n  LedgerReadRole:")
        .nth(1)
        .and_then(|rest| rest.split("\n  LedgerReadLogGroup:").next())
        .expect("the ledger read role");
    assert!(role.contains("'lambda:InvokeFunction'"));
    assert!(role.contains("Resource: !GetAtt ExchangeRatesUpdateFunction.Arn"));

    // Starting it is fire and forget, so a failed update must not be retried behind the reads.
    let config = TEMPLATE
        .split("\n  ExchangeRatesUpdateInvokeConfig:")
        .nth(1)
        .expect("the update's invoke config");
    assert!(config.contains("MaximumRetryAttempts: 0"));
}
