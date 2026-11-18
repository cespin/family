//! Request parsing and response shaping for the `aws_proxy` Lambdas.

use lambda_http::http::header::{HeaderValue, CACHE_CONTROL, CONTENT_TYPE};
use lambda_http::http::StatusCode;
use lambda_http::{Body, Request, Response};

use crate::error::ApiError;

const FALLBACK_ERROR_BODY: &str =
    r#"{"error":{"code":"internal_error","message":"An unexpected error occurred."}}"#;

#[derive(serde::Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorDetail<'a>,
}

#[derive(serde::Serialize)]
struct ErrorDetail<'a> {
    code: &'a str,
    message: &'a str,
}

pub fn json_response<T: serde::Serialize>(status: u16, body: &T) -> Response<Body> {
    match serde_json::to_string(body) {
        Ok(payload) => json_string_response(status, payload),
        Err(e) => {
            tracing::error!(error = %e, "response body failed to serialise");
            json_string_response(500, FALLBACK_ERROR_BODY.to_string())
        }
    }
}

pub fn no_content() -> Response<Body> {
    let mut res = Response::new(Body::Empty);
    *res.status_mut() = StatusCode::NO_CONTENT;
    res
}

/// Applied around a handler's whole dispatch, so error responses are covered too.
pub fn no_store(mut res: Response<Body>) -> Response<Body> {
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The handler-side twin of the API's gateway responses.
pub fn error_response(err: &ApiError) -> Response<Body> {
    match err {
        ApiError::Internal(detail) => tracing::error!(detail = %detail, "handler failed"),
        ApiError::Forbidden(detail) => tracing::warn!(detail = %detail, "request refused"),
        _ => {}
    }
    let message = err.client_message();
    let payload = serde_json::to_string(&ErrorEnvelope {
        error: ErrorDetail {
            code: err.code(),
            message: &message,
        },
    })
    .unwrap_or_else(|_| FALLBACK_ERROR_BODY.to_string());
    json_string_response(err.status(), payload)
}

fn json_string_response(status: u16, payload: String) -> Response<Body> {
    let mut res = Response::new(Body::from(payload));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

pub fn parse_json_body<T: serde::de::DeserializeOwned>(event: &Request) -> crate::Result<T> {
    let parsed = match event.body() {
        Body::Text(text) if !text.trim().is_empty() => serde_json::from_str::<T>(text),
        Body::Binary(bytes) if !bytes.is_empty() => serde_json::from_slice::<T>(bytes),
        _ => return Err(ApiError::validation("The request body is empty.")),
    };
    parsed.map_err(ApiError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn body_json(res: &Response<Body>) -> serde_json::Value {
        match res.body() {
            Body::Text(t) => serde_json::from_str(t).expect("body is JSON"),
            other => panic!("expected a text body, got {other:?}"),
        }
    }

    fn request(body: Body) -> Request {
        lambda_http::http::Request::builder()
            .method("POST")
            .uri("https://example.test/api/thing")
            .body(body)
            .expect("valid test request")
    }

    #[test]
    fn errors_use_the_shared_envelope() {
        let res = error_response(&ApiError::not_found("no such thing"));
        assert_eq!(res.status(), 404);
        assert_eq!(
            body_json(&res),
            serde_json::json!({"error": {"code": "not_found", "message": "no such thing"}})
        );
    }

    #[test]
    fn internal_detail_never_reaches_the_body() {
        let res = error_response(&ApiError::internal("table main-fa01-family throttled"));
        assert!(!body_json(&res).to_string().contains("main-fa01-family"));
    }

    #[test]
    fn the_fallback_body_matches_a_rendered_internal_error() {
        let fallback: serde_json::Value =
            serde_json::from_str(FALLBACK_ERROR_BODY).expect("fallback is JSON");
        assert_eq!(
            fallback,
            body_json(&error_response(&ApiError::internal("x")))
        );
    }

    #[test]
    fn no_store_is_applied_to_error_responses() {
        let res = no_store(error_response(&ApiError::forbidden("no")));
        assert_eq!(res.headers().get(CACHE_CONTROL).unwrap(), "no-store");
    }

    #[rstest]
    #[case(Body::Text(r#"{"a":1}"#.to_string()))]
    #[case(Body::Binary(br#"{"a":1}"#.to_vec()))]
    fn parses_text_and_binary_bodies(#[case] body: Body) {
        let parsed: serde_json::Value = parse_json_body(&request(body)).expect("parses");
        assert_eq!(parsed["a"], 1);
    }

    #[rstest]
    #[case(Body::Empty)]
    #[case(Body::Text("   ".to_string()))]
    #[case(Body::Text("{oops".to_string()))]
    fn rejects_empty_and_malformed_bodies(#[case] body: Body) {
        let err = parse_json_body::<serde_json::Value>(&request(body)).expect_err("rejected");
        assert_eq!(err.status(), 400);
    }
}
