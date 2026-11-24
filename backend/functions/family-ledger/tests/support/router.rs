//! Sends a request through the handler its route is deployed on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use family_core::{ApiError, Result};
use family_ledger::api;
use family_ledger::rules::exact;
use family_ledger::rules::rates::Quote;
use family_ledger::service::env::Env;
use family_ledger::service::rates::{RateFetcher, RatesUpdate};
use family_ledger::store::table::Table;
use lambda_http::aws_lambda_events::apigw::{
    ApiGatewayProxyRequestContext, ApiGatewayRequestAuthorizer,
};
use lambda_http::request::RequestContext;
use lambda_http::{Body, Request, RequestExt};
use serde_json::{json, Value};

#[derive(Default)]
pub struct FixedEnv {
    ids: AtomicUsize,
}

impl Env for FixedEnv {
    fn now(&self) -> String {
        "2026-11-18T12:00:00Z".to_string()
    }

    fn new_id(&self) -> String {
        let number = self.ids.fetch_add(1, Ordering::Relaxed) + 1;
        format!("a1000000-0000-4000-8000-{number:012}")
    }
}

/// The rate services, answering what a test says. Each answer is `{ "usdCad", "usdClp" }` as
/// decimal text, or null for a service that failed. By default all three agree on 1 USD = 1.41 CAD
/// and 1 CAD = 672 CLP.
pub struct FakeFetcher {
    answers: Vec<Value>,
    pub calls: AtomicUsize,
}

impl FakeFetcher {
    pub fn new(answers: Option<&Value>) -> Self {
        let agreeing = json!({ "usdCad": "1.41", "usdClp": "947.52" });
        let answers = match answers {
            Some(Value::Array(answers)) => answers.clone(),
            _ => vec![agreeing.clone(), agreeing.clone(), agreeing],
        };
        Self {
            answers,
            calls: AtomicUsize::new(0),
        }
    }
}

impl RateFetcher for FakeFetcher {
    async fn fetch(&self) -> Vec<Result<Quote>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let decimal = |answer: &Value, field: &str| {
            exact::decimal(answer[field].as_str().expect("a decimal string")).expect("a decimal")
        };
        self.answers
            .iter()
            .enumerate()
            .map(|(index, answer)| match answer {
                Value::Null => Err(ApiError::rates_unavailable("the service timed out")),
                answer => Ok(Quote {
                    source: format!("fake-{}", index + 1),
                    usd_cad: decimal(answer, "usdCad"),
                    usd_clp: decimal(answer, "usdClp"),
                }),
            })
            .collect()
    }
}

/// Records each background update a read starts.
#[derive(Default)]
pub struct FakeUpdate {
    pub starts: Mutex<usize>,
    pub refuse: bool,
}

impl RatesUpdate for FakeUpdate {
    async fn start(&self) -> Result<()> {
        *self.starts.lock().unwrap() += 1;
        if self.refuse {
            Err(ApiError::internal("the update could not be queued"))
        } else {
            Ok(())
        }
    }
}

pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub cache_control: Option<String>,
}

fn request(caller: &str, method: &str, path: &str, body: Option<&Value>) -> Request {
    let email = format!("{caller}@example.test");
    let mut authorizer = ApiGatewayRequestAuthorizer::default();
    authorizer.fields.insert(
        "claims".to_string(),
        json!({ "sub": format!("sub-{caller}"), "email": email, "name": caller }),
    );
    let mut context = ApiGatewayProxyRequestContext::default();
    context.authorizer = authorizer;

    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let parameters: HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let segments: Vec<&str> = route.trim_matches('/').split('/').collect();
    let mut path_parameters = HashMap::new();
    if let ["api", resource, id] = segments.as_slice() {
        let name = match *resource {
            "groups" => "groupId",
            "payments" => "paymentId",
            _ => "expenseId",
        };
        path_parameters.insert(name.to_string(), id.to_string());
    }

    let payload = body.map_or(Body::Empty, |value| Body::Text(value.to_string()));
    lambda_http::http::Request::builder()
        .method(method)
        .uri(format!("https://example.test{route}"))
        .body(payload)
        .expect("a valid test request")
        .with_query_string_parameters(parameters)
        .with_path_parameters(path_parameters)
        .with_request_context(RequestContext::ApiGatewayV1(context))
}

pub async fn send<T: Table>(
    table: &T,
    caller: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Answer {
    let fetcher = FakeFetcher::new(None);
    send_with(
        table,
        &fetcher,
        &FakeUpdate::default(),
        caller,
        method,
        path,
        body,
    )
    .await
}

/// Sends a recorded write. A rate refresh carries what the services answer in `answers`.
pub async fn send_write<T: Table>(table: &T, write: &Value) -> Answer {
    let fetcher = FakeFetcher::new(write.get("answers"));
    send_with(
        table,
        &fetcher,
        &FakeUpdate::default(),
        write["caller"].as_str().unwrap(),
        write["method"].as_str().unwrap(),
        write["path"].as_str().unwrap(),
        write.get("body"),
    )
    .await
}

pub async fn send_with<T: Table, F: RateFetcher, U: RatesUpdate>(
    table: &T,
    fetcher: &F,
    update: &U,
    caller: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Answer {
    let env = FixedEnv::default();
    let event = request(caller, method, path, body);
    let route = path.split('?').next().unwrap();
    let response = match (method, route) {
        ("GET", "/api/me") => api::me_get(table, &event).await,
        ("PUT", "/api/me/profile") => api::me_profile_put(table, &env, &event).await,
        ("GET", _) => api::ledger_read(table, &env, update, &event).await,
        (_, r) if r.starts_with("/api/expenses") => api::expenses_write(table, &env, &event).await,
        (_, r) if r.starts_with("/api/payments") => api::payments_post(table, &env, &event).await,
        (_, r) if r.starts_with("/api/groups") => api::groups_write(table, &event).await,
        (_, r) if r.starts_with("/api/exchange-rates") => {
            api::exchange_rates_refresh(table, fetcher, &env, &event).await
        }
        other => panic!("no handler for {other:?}"),
    };
    let cache_control = response
        .headers()
        .get("cache-control")
        .map(|value| value.to_str().unwrap().to_string());
    let body = match response.body() {
        Body::Text(text) => serde_json::from_str(text).expect("a JSON body"),
        Body::Empty => Value::Null,
        other => panic!("unexpected body {other:?}"),
    };
    Answer {
        status: response.status().as_u16(),
        body,
        cache_control,
    }
}
