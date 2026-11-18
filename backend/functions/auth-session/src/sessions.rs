//! Calls to Cognito's OAuth endpoints.
//!
//! Federated users cannot use the user pools API, so these are the hosted `/oauth2/*` endpoints.
//! Nothing here may log a token, a code or a successful response body.

use std::future::Future;
use std::time::Duration;

use family_core::{ApiError, Result};
use serde::Deserialize;

const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct Tokens {
    pub(crate) id_token: String,
    /// Present on a code exchange, and on a refresh only when Cognito rotates the token.
    pub(crate) refresh_token: Option<String>,
}

/// Cognito's OAuth error body. Neither field carries a credential, so both are safe to log.
#[derive(Debug, Default, Deserialize)]
struct OAuthError {
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grant {
    Code,
    Refresh,
}

/// Turns a token endpoint response into tokens or the error the caller should see.
///
/// Cognito runs the pre token generation trigger during the code exchange, so this is where a
/// removed family member is refused. Cognito reports the trigger's text in the `error` field, for
/// example `PreTokenGeneration failed with error not_invited. (Service: ...)`. That refusal becomes
/// `Forbidden`, which the frontend shows as the not-invited screen. A refused refresh stays
/// `Unauthorized`, which signs the person out.
fn parse_token_response(grant: Grant, status: u16, body: &str) -> Result<Tokens> {
    match status {
        200 => serde_json::from_str(body)
            .map_err(|e| ApiError::internal(format!("unexpected token response: {e}"))),
        400 | 401 => {
            let refusal: OAuthError = serde_json::from_str(body).unwrap_or_default();
            let error = refusal.error.as_deref().unwrap_or_default();
            let description = refusal.error_description.as_deref().unwrap_or_default();
            tracing::warn!(
                status,
                error,
                description,
                ?grant,
                "Cognito refused a token request"
            );

            let names = |text: &str| error.contains(text) || description.contains(text);
            if names("allowlist_unavailable") {
                return Err(ApiError::internal(
                    "the allowlist check failed during sign-in",
                ));
            }
            if grant == Grant::Code && names("not_invited") {
                return Err(ApiError::forbidden("sign-in denied by the allowlist"));
            }
            Err(ApiError::unauthorized(format!(
                "Cognito refused with {status}"
            )))
        }
        other => Err(ApiError::internal(format!("Cognito answered {other}"))),
    }
}

pub(crate) trait Sessions: Send + Sync {
    fn exchange(&self, code: &str, verifier: &str) -> impl Future<Output = Result<Tokens>> + Send;
    fn refresh(&self, refresh_token: &str) -> impl Future<Output = Result<Tokens>> + Send;
    fn revoke(&self, refresh_token: &str) -> impl Future<Output = Result<()>> + Send;
}

pub(crate) struct CognitoSessions {
    agent: ureq::Agent,
    domain: String,
    client_id: String,
    redirect_uri: String,
}

impl CognitoSessions {
    pub(crate) fn new(domain: String, client_id: String, site_origin: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            agent,
            domain,
            client_id,
            redirect_uri: format!("{site_origin}/auth/callback"),
        }
    }

    /// Blocking, so it runs on the blocking pool. Returns the status and the body.
    async fn post(&self, path: &str, form: Vec<(&'static str, String)>) -> Result<(u16, String)> {
        let agent = self.agent.clone();
        let url = format!("https://{}{path}", self.domain);
        tokio::task::spawn_blocking(move || {
            let mut response = agent
                .post(&url)
                .send_form(form.iter().map(|(key, value)| (*key, value.as_str())))
                .map_err(|e| ApiError::internal(format!("Cognito request failed: {e}")))?;
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .read_to_string()
                .map_err(|e| ApiError::internal(format!("Cognito response unreadable: {e}")))?;
            Ok((status, body))
        })
        .await
        .map_err(|e| ApiError::internal(format!("Cognito task failed: {e}")))?
    }

    async fn token_request(
        &self,
        grant: Grant,
        form: Vec<(&'static str, String)>,
    ) -> Result<Tokens> {
        let (status, body) = self.post("/oauth2/token", form).await?;
        parse_token_response(grant, status, &body)
    }
}

impl Sessions for CognitoSessions {
    async fn exchange(&self, code: &str, verifier: &str) -> Result<Tokens> {
        let form = vec![
            ("grant_type", "authorization_code".to_string()),
            ("client_id", self.client_id.clone()),
            ("redirect_uri", self.redirect_uri.clone()),
            ("code", code.to_string()),
            ("code_verifier", verifier.to_string()),
        ];
        self.token_request(Grant::Code, form).await
    }

    async fn refresh(&self, refresh_token: &str) -> Result<Tokens> {
        let form = vec![
            ("grant_type", "refresh_token".to_string()),
            ("client_id", self.client_id.clone()),
            ("refresh_token", refresh_token.to_string()),
        ];
        self.token_request(Grant::Refresh, form).await
    }

    async fn revoke(&self, refresh_token: &str) -> Result<()> {
        let form = vec![
            ("client_id", self.client_id.clone()),
            ("token", refresh_token.to_string()),
        ];
        let (status, _) = self.post("/oauth2/revoke", form).await?;
        if status == 200 {
            Ok(())
        } else {
            Err(ApiError::internal(format!("revoke answered {status}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[test]
    fn a_successful_response_yields_the_tokens() {
        let body = r#"{"id_token":"id","refresh_token":"refresh","access_token":"a"}"#;
        let tokens = parse_token_response(Grant::Code, 200, body).expect("tokens");
        assert_eq!(tokens.id_token, "id");
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh"));
    }

    /// The body Cognito returned on the live site for a removed member.
    const REMOVED_MEMBER: &str = r#"{"error":"PreTokenGeneration failed with error not_invited. (Service: AWSCognitoIdentityProviderInternalService; Status Code: 400; Error Code: UserLambdaValidationException)"}"#;

    #[rstest]
    #[case(REMOVED_MEMBER)]
    #[case(r#"{"error":"invalid_request","error_description":"failed with error not_invited."}"#)]
    fn a_removed_member_is_forbidden_at_the_code_exchange(#[case] body: &str) {
        let err = parse_token_response(Grant::Code, 400, body).expect_err("refused");
        assert_eq!(err.status(), 403);
    }

    #[rstest]
    #[case(r#"{"error":"invalid_grant"}"#)]
    #[case(r#"{"error":"invalid_request"}"#)]
    #[case(r#"{"error":"invalid_client"}"#)]
    #[case("not json")]
    fn other_refused_exchanges_are_not_reported_as_uninvited(#[case] body: &str) {
        let err = parse_token_response(Grant::Code, 400, body).expect_err("refused");
        assert_eq!(err.status(), 401);
    }

    #[rstest]
    #[case(r#"{"error":"invalid_grant"}"#)]
    #[case(REMOVED_MEMBER)]
    fn a_refused_refresh_signs_out(#[case] body: &str) {
        let err = parse_token_response(Grant::Refresh, 400, body).expect_err("refused");
        assert_eq!(err.status(), 401);
    }

    #[rstest]
    #[case(r#"{"error":"PreTokenGeneration failed with error allowlist_unavailable."}"#)]
    #[case(r#"{"error":"invalid_request","error_description":"failed with error allowlist_unavailable."}"#)]
    fn an_allowlist_outage_is_not_reported_as_uninvited(#[case] body: &str) {
        let err = parse_token_response(Grant::Code, 400, body).expect_err("refused");
        assert_eq!(err.status(), 500);
    }

    #[test]
    fn an_unexpected_status_is_an_internal_error() {
        let err = parse_token_response(Grant::Code, 503, "").expect_err("refused");
        assert_eq!(err.status(), 500);
    }
}
