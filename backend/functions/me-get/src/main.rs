//! `GET /api/me`: who is signed in.
//!
//! The authorizer only proves the token is valid. The allowlist is re-read here so that removing a
//! family member takes effect immediately on this route, even while their token is unexpired.

use aws_config::BehaviorVersion;
use family_core::claims::Caller;
use family_core::config::required_env;
use family_core::ddb::{DynamoMembers, Members};
use family_core::{http, ApiError, Result};
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse<'a> {
    sub: &'a str,
    email: &'a str,
    name: Option<&'a str>,
}

async fn dispatch<M: Members>(members: &M, event: &Request) -> Result<Response<Body>> {
    let caller = Caller::from_request(event)?;
    if !members.is_member(&caller.email).await? {
        return Err(ApiError::forbidden(format!(
            "sub {} is no longer on the allowlist",
            caller.sub
        )));
    }
    Ok(http::json_response(
        200,
        &MeResponse {
            sub: &caller.sub,
            email: &caller.email,
            name: caller.name.as_deref(),
        },
    ))
}

async fn function_handler<M: Members>(
    members: &M,
    event: Request,
) -> std::result::Result<Response<Body>, Error> {
    Ok(http::no_store(
        dispatch(members, &event)
            .await
            .unwrap_or_else(|err| http::error_response(&err)),
    ))
}

#[tokio::main]
async fn main() -> std::result::Result<(), Error> {
    lambda_http::tracing::init_default_subscriber();
    let table_name = required_env("TABLE_NAME")?;
    let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let members = DynamoMembers::new(aws_sdk_dynamodb::Client::new(&shared), table_name);
    let members = &members;
    run(service_fn(move |event: Request| async move {
        function_handler(members, event).await
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use lambda_http::aws_lambda_events::apigw::{
        ApiGatewayProxyRequestContext, ApiGatewayRequestAuthorizer,
    };
    use lambda_http::request::RequestContext;
    use lambda_http::RequestExt;

    struct FakeMembers(bool);

    impl Members for FakeMembers {
        async fn is_member(&self, _email: &str) -> Result<bool> {
            Ok(self.0)
        }
    }

    fn signed_in_request() -> Request {
        let mut authorizer = ApiGatewayRequestAuthorizer::default();
        authorizer.fields.insert(
            "claims".to_string(),
            serde_json::json!({"sub": "abc", "email": "ana@example.test", "name": "Ana"}),
        );
        let mut context = ApiGatewayProxyRequestContext::default();
        context.authorizer = authorizer;
        lambda_http::http::Request::builder()
            .uri("https://example.test/api/me")
            .body(Body::Empty)
            .expect("valid test request")
            .with_request_context(RequestContext::ApiGatewayV1(context))
    }

    #[tokio::test]
    async fn a_member_gets_their_profile() {
        let response = function_handler(&FakeMembers(true), signed_in_request())
            .await
            .expect("handler succeeds");
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    }

    #[tokio::test]
    async fn a_removed_member_is_refused_despite_a_valid_token() {
        let response = function_handler(&FakeMembers(false), signed_in_request())
            .await
            .expect("handler succeeds");
        assert_eq!(response.status(), 403);
    }
}
