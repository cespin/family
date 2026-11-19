//! Sends a request through the handler its route is deployed on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use family_ledger::api;
use family_ledger::service::env::Env;
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
    let env = FixedEnv::default();
    let event = request(caller, method, path, body);
    let route = path.split('?').next().unwrap();
    let response = match (method, route) {
        ("GET", "/api/me") => api::me_get(table, &event).await,
        ("PUT", "/api/me/profile") => api::me_profile_put(table, &env, &event).await,
        ("GET", _) => api::ledger_read(table, &event).await,
        (_, r) if r.starts_with("/api/expenses") => api::expenses_write(table, &env, &event).await,
        (_, r) if r.starts_with("/api/payments") => api::payments_post(table, &env, &event).await,
        (_, r) if r.starts_with("/api/groups") => api::groups_write(table, &event).await,
        (_, "/api/exchange-rates") => api::exchange_rates_post(table, &event).await,
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
