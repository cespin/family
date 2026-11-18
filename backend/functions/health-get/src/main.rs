//! `GET /api/health`: confirms the API is reachable. Public, and touches no data.

use family_core::http;
use lambda_http::{run, service_fn, Body, Error, Request, Response};

async fn function_handler(_event: Request) -> Result<Response<Body>, Error> {
    Ok(http::no_store(http::json_response(
        200,
        &serde_json::json!({ "status": "ok" }),
    )))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_http::tracing::init_default_subscriber();
    run(service_fn(function_handler)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn answers_ok_and_is_never_cached() {
        let request = lambda_http::http::Request::builder()
            .uri("https://example.test/api/health")
            .body(Body::Empty)
            .expect("valid test request");
        let response = function_handler(request).await.expect("handler succeeds");
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    }
}
