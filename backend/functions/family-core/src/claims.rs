//! Who is calling, read from the API Gateway Cognito authorizer's claims and nothing else.

use lambda_http::request::RequestContext;
use lambda_http::{Request, RequestExt};

use crate::{ApiError, Result};

/// The verified caller. Identity never comes from a request body or a self-parsed header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub sub: String,
    pub email: String,
    pub name: Option<String>,
}

impl Caller {
    /// Every failure is `Unauthorized`: a request without usable claims did not come through the
    /// authorizer, or came through a misconfigured one.
    pub fn from_request(event: &Request) -> Result<Self> {
        let Some(RequestContext::ApiGatewayV1(context)) = event.request_context_ref() else {
            return Err(ApiError::unauthorized(
                "request carried no API Gateway context",
            ));
        };
        let claims = context
            .authorizer
            .fields
            .get("claims")
            .and_then(|claims| claims.as_object())
            .ok_or_else(|| ApiError::unauthorized("request carried no authorizer claims"))?;

        let claim = |name: &str| {
            claims
                .get(name)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };

        Ok(Self {
            sub: claim("sub").ok_or_else(|| ApiError::unauthorized("claims carried no sub"))?,
            email: claim("email")
                .ok_or_else(|| ApiError::unauthorized("claims carried no email"))?,
            name: claim("name"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lambda_http::aws_lambda_events::apigw::{
        ApiGatewayProxyRequestContext, ApiGatewayRequestAuthorizer,
    };
    use lambda_http::Body;
    use serde_json::json;

    fn request_with(claims: serde_json::Value) -> Request {
        let mut authorizer = ApiGatewayRequestAuthorizer::default();
        authorizer.fields.insert("claims".to_string(), claims);
        let mut context = ApiGatewayProxyRequestContext::default();
        context.authorizer = authorizer;
        lambda_http::http::Request::builder()
            .uri("https://example.test/api/me")
            .body(Body::Empty)
            .expect("valid test request")
            .with_request_context(RequestContext::ApiGatewayV1(context))
    }

    #[test]
    fn reads_the_caller_from_the_authorizer_claims() {
        let caller = Caller::from_request(&request_with(
            json!({"sub": "abc", "email": "ana@example.test", "name": "Ana"}),
        ))
        .expect("claims are readable");
        assert_eq!(caller.sub, "abc");
        assert_eq!(caller.email, "ana@example.test");
        assert_eq!(caller.name.as_deref(), Some("Ana"));
    }

    #[test]
    fn missing_or_blank_identity_is_unauthorized() {
        for claims in [
            json!({"email": "ana@example.test"}),
            json!({"sub": "   ", "email": "ana@example.test"}),
            json!({"sub": "abc"}),
        ] {
            let err = Caller::from_request(&request_with(claims)).expect_err("refused");
            assert_eq!(err.status(), 401);
        }
    }

    #[test]
    fn a_request_without_context_is_unauthorized() {
        let request = lambda_http::http::Request::builder()
            .uri("https://example.test/api/me")
            .body(Body::Empty)
            .expect("valid test request");
        assert_eq!(
            Caller::from_request(&request)
                .expect_err("refused")
                .status(),
            401
        );
    }
}
