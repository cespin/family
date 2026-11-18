//! Cognito triggers that enforce the invite-only allowlist.
//!
//! Pre sign-up only runs on someone's first sign-in, so pre token generation repeats the check on
//! every token issue. That is what ends a removed member's access at their next refresh.
//!
//! The refusal text reaches the browser in the callback's `error_description`. The frontend looks
//! for [`NOT_INVITED`] to show the not-invited screen, so the two must stay in step.

use aws_config::BehaviorVersion;
use family_core::config::required_env;
use family_core::ddb::{DynamoMembers, Members};
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;

const NOT_INVITED: &str = "not_invited";

async fn check<M: Members>(members: &M, event: &Value) -> Result<(), Error> {
    let trigger = event["triggerSource"].as_str().unwrap_or_default();
    let attributes = &event["request"]["userAttributes"];
    let email = attributes["email"].as_str().unwrap_or_default();

    let must_be_verified = match trigger {
        "PreSignUp_ExternalProvider" => true,
        source if source.starts_with("TokenGeneration_") => false,
        // Fail closed: no other way of creating an account is allowed.
        other => {
            tracing::warn!(trigger = other, "refused an unexpected trigger");
            return Err(NOT_INVITED.into());
        }
    };

    if email.is_empty() || (must_be_verified && attributes["email_verified"] != "true") {
        tracing::warn!(trigger, "refused an identity without a verified email");
        return Err(NOT_INVITED.into());
    }

    if members.is_member(email).await.map_err(|err| {
        tracing::error!(%err, "allowlist check failed");
        Error::from("allowlist_unavailable")
    })? {
        Ok(())
    } else {
        tracing::warn!(trigger, "refused an address that is not on the allowlist");
        Err(NOT_INVITED.into())
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_runtime::tracing::init_default_subscriber();
    let table_name = required_env("TABLE_NAME")?;
    let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let members = DynamoMembers::new(aws_sdk_dynamodb::Client::new(&shared), table_name);
    let members = &members;
    run(service_fn(move |event: LambdaEvent<Value>| async move {
        check(members, &event.payload).await?;
        // Cognito expects the event back unchanged.
        Ok::<Value, Error>(event.payload)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use family_core::{ApiError, Result as CoreResult};
    use rstest::rstest;
    use serde_json::json;

    struct FakeMembers(CoreResult<bool>);

    impl Members for FakeMembers {
        async fn is_member(&self, _email: &str) -> CoreResult<bool> {
            match &self.0 {
                Ok(value) => Ok(*value),
                Err(_) => Err(ApiError::internal("table unavailable")),
            }
        }
    }

    fn event(trigger: &str, verified: &str) -> Value {
        json!({
            "triggerSource": trigger,
            "request": {"userAttributes": {"email": "ana@example.test", "email_verified": verified}}
        })
    }

    #[rstest]
    #[case("PreSignUp_ExternalProvider", "true")]
    #[case("TokenGeneration_HostedAuth", "true")]
    #[case("TokenGeneration_RefreshTokens", "false")]
    #[tokio::test]
    async fn an_invited_member_is_allowed(#[case] trigger: &str, #[case] verified: &str) {
        assert!(check(&FakeMembers(Ok(true)), &event(trigger, verified))
            .await
            .is_ok());
    }

    #[rstest]
    #[case("PreSignUp_ExternalProvider")]
    #[case("TokenGeneration_RefreshTokens")]
    #[tokio::test]
    async fn someone_not_invited_is_refused(#[case] trigger: &str) {
        let err = check(&FakeMembers(Ok(false)), &event(trigger, "true"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), NOT_INVITED);
    }

    #[tokio::test]
    async fn an_unverified_google_address_is_refused_even_if_listed() {
        let event = event("PreSignUp_ExternalProvider", "false");
        let err = check(&FakeMembers(Ok(true)), &event).await.unwrap_err();
        assert_eq!(err.to_string(), NOT_INVITED);
    }

    #[rstest]
    #[case("PreSignUp_SignUp")]
    #[case("PreSignUp_AdminCreateUser")]
    #[case("")]
    #[tokio::test]
    async fn every_other_trigger_fails_closed(#[case] trigger: &str) {
        let err = check(&FakeMembers(Ok(true)), &event(trigger, "true"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), NOT_INVITED);
    }

    #[tokio::test]
    async fn a_table_failure_refuses_without_claiming_the_user_is_not_invited() {
        let members = FakeMembers(Err(ApiError::internal("down")));
        let err = check(&members, &event("TokenGeneration_HostedAuth", "true"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "allowlist_unavailable");
    }
}
