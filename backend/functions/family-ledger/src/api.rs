//! The HTTP side of each Lambda: which route was called, and how its answer goes on the wire.

use std::collections::HashMap;

use family_core::claims::Caller;
use family_core::{http, ApiError, Result};
use lambda_http::http::Method;
use lambda_http::{Body, Request, RequestExt, Response};
use serde_json::Value;

use crate::service::env::Env;
use crate::service::reads::{ExpenseFilters, PaymentFilters};
use crate::service::{expenses, groups, payments, profile, rates, reads};
use crate::store::table::Table;

/// Every response is uncacheable, and a failure becomes the shared error envelope.
fn finish(status: u16, result: Result<Value>) -> Response<Body> {
    http::no_store(match result {
        Ok(body) => http::json_response(status, &body),
        Err(error) => http::error_response(&error),
    })
}

fn no_route() -> ApiError {
    ApiError::not_found("This route does not exist.")
}

fn path_of(event: &Request) -> &str {
    let path = event.uri().path();
    path.find("/api/").map_or(path, |start| &path[start..])
}

fn path_parameter(event: &Request, name: &str) -> Result<String> {
    event
        .path_parameters_ref()
        .and_then(|parameters| parameters.first(name))
        .map(str::to_string)
        .ok_or_else(no_route)
}

fn query_parameters(event: &Request) -> HashMap<String, String> {
    event
        .query_string_parameters_ref()
        .map(|parameters| {
            parameters
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// `GET /api/me`.
pub async fn me_get<T: Table>(table: &T, event: &Request) -> Response<Body> {
    let result = async {
        let caller = Caller::from_request(event)?;
        reads::me(table, &caller).await
    };
    finish(200, result.await)
}

/// `PUT /api/me/profile`.
pub async fn me_profile_put<T: Table, E: Env>(
    table: &T,
    env: &E,
    event: &Request,
) -> Response<Body> {
    let result = async {
        let caller = Caller::from_request(event)?;
        profile::put_profile(table, env, &caller, http::parse_json_body(event)?).await
    };
    finish(200, result.await)
}

/// `GET /api/ledger`, `/api/expenses`, `/api/expenses/{expenseId}` and `/api/payments`.
pub async fn ledger_read<T: Table>(table: &T, event: &Request) -> Response<Body> {
    let result = async {
        let caller = Caller::from_request(event)?;
        let mut query = query_parameters(event);
        let path = path_of(event);
        if path == "/api/ledger" {
            reads::ledger(table, &caller).await
        } else if path == "/api/expenses" {
            let filters = ExpenseFilters {
                group_id: query.remove("groupId"),
                kind: query.remove("kind"),
                limit: query.remove("limit"),
                cursor: query.remove("cursor"),
            };
            reads::list_expenses(table, &caller, &filters).await
        } else if path == "/api/payments" {
            let filters = PaymentFilters {
                member_id: query.remove("memberId"),
                limit: query.remove("limit"),
                cursor: query.remove("cursor"),
            };
            reads::list_payments(table, &caller, &filters).await
        } else if path.starts_with("/api/expenses/") {
            reads::get_expense(table, &caller, &path_parameter(event, "expenseId")?).await
        } else {
            Err(no_route())
        }
    };
    finish(200, result.await)
}

/// `POST /api/expenses` and `PUT /api/expenses/{expenseId}`.
pub async fn expenses_write<T: Table, E: Env>(
    table: &T,
    env: &E,
    event: &Request,
) -> Response<Body> {
    let creating = event.method() == Method::POST;
    let result = async {
        let caller = Caller::from_request(event)?;
        let body = http::parse_json_body(event)?;
        if creating {
            expenses::post_expense(table, env, &caller, body).await
        } else {
            let expense_id = path_parameter(event, "expenseId")?;
            expenses::put_expense(table, &caller, &expense_id, body).await
        }
    };
    finish(if creating { 201 } else { 200 }, result.await)
}

/// `POST /api/payments`.
pub async fn payments_post<T: Table, E: Env>(
    table: &T,
    env: &E,
    event: &Request,
) -> Response<Body> {
    let result = async {
        let caller = Caller::from_request(event)?;
        payments::post_payment(table, env, &caller, http::parse_json_body(event)?).await
    };
    finish(201, result.await)
}

/// `POST /api/groups` and `PUT /api/groups/{groupId}`.
pub async fn groups_write<T: Table>(table: &T, event: &Request) -> Response<Body> {
    let creating = event.method() == Method::POST;
    let result = async {
        let caller = Caller::from_request(event)?;
        let body = http::parse_json_body(event)?;
        if creating {
            groups::post_group(table, &caller, body).await
        } else {
            let group_id = path_parameter(event, "groupId")?;
            groups::put_group(table, &caller, &group_id, body).await
        }
    };
    finish(if creating { 201 } else { 200 }, result.await)
}

/// `POST /api/exchange-rates`.
pub async fn exchange_rates_post<T: Table>(table: &T, event: &Request) -> Response<Body> {
    let result = async {
        let caller = Caller::from_request(event)?;
        rates::post_rates(table, &caller, http::parse_json_body(event)?).await
    };
    finish(201, result.await)
}
