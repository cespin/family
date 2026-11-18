//! One Lambda behind three routes that have no authorizer, because each one either establishes the
//! session or must work after the ID token has expired.
//!
//! | route | job |
//! |---|---|
//! | `POST /api/auth/session` | exchange the authorization code and set the cookie |
//! | `POST /api/auth/session/refresh` | restore on page load and renew before expiry |
//! | `DELETE /api/auth/session` | revoke and clear |
//!
//! Nothing here may log a request body or a `Cookie` header.

use family_core::{http, ApiError, Result};
use lambda_http::http::header::{COOKIE, ORIGIN, SET_COOKIE};
use lambda_http::http::{HeaderValue, Method};
use lambda_http::{Body, Error, Request, Response};
use serde::{Deserialize, Serialize};

use crate::cookie;
use crate::sessions::Sessions;

const BASE_PATH: &str = "/api/auth/session";

pub(crate) struct Deps<'a, S: Sessions> {
    pub(crate) sessions: &'a S,
    pub(crate) site_origin: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MintRequest {
    code: String,
    code_verifier: String,
}

/// The refresh token goes into the cookie and must never appear in a body JavaScript can read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse<'a> {
    id_token: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    Mint,
    Refresh,
    SignOut,
}

fn route_of(method: &Method, path: &str) -> Option<Route> {
    let path = path.trim_end_matches('/');
    let tail = &path[path.find(BASE_PATH)? + BASE_PATH.len()..];
    match (method, tail) {
        (&Method::POST, "") => Some(Route::Mint),
        (&Method::POST, "/refresh") => Some(Route::Refresh),
        (&Method::DELETE, "") => Some(Route::SignOut),
        _ => None,
    }
}

pub(crate) async fn function_handler<S: Sessions>(
    deps: &Deps<'_, S>,
    event: Request,
) -> std::result::Result<Response<Body>, Error> {
    Ok(http::no_store(
        dispatch(deps, event)
            .await
            .unwrap_or_else(|err| http::error_response(&err)),
    ))
}

async fn dispatch<S: Sessions>(deps: &Deps<'_, S>, event: Request) -> Result<Response<Body>> {
    let Some(route) = route_of(event.method(), event.uri().path()) else {
        return Err(ApiError::not_found("No such route."));
    };
    check_origin(&event, deps.site_origin)?;
    match route {
        Route::Mint => mint(deps, &event).await,
        Route::Refresh => refresh(deps, &event).await,
        Route::SignOut => sign_out(deps, &event).await,
    }
}

/// Rejects a request whose `Origin` is present and is not this site. Browsers always send it on
/// these requests, so an absent header can only be a non-browser caller.
fn check_origin(event: &Request, site_origin: &str) -> Result<()> {
    let Some(origin) = event.headers().get(ORIGIN) else {
        return Ok(());
    };
    let origin = origin.to_str().unwrap_or_default();
    if origin == site_origin {
        return Ok(());
    }
    Err(ApiError::forbidden(format!("rejected Origin {origin:?}")))
}

async fn mint<S: Sessions>(deps: &Deps<'_, S>, event: &Request) -> Result<Response<Body>> {
    let body: MintRequest = http::parse_json_body(event)?;
    let tokens = deps
        .sessions
        .exchange(&body.code, &body.code_verifier)
        .await?;
    let refresh_token = tokens
        .refresh_token
        .as_deref()
        .ok_or_else(|| ApiError::internal("the code exchange returned no refresh token"))?;
    with_cookie(
        http::json_response(
            200,
            &SessionResponse {
                id_token: &tokens.id_token,
            },
        ),
        cookie::set(refresh_token),
    )
}

async fn refresh<S: Sessions>(deps: &Deps<'_, S>, event: &Request) -> Result<Response<Body>> {
    match refresh_inner(deps, event).await {
        Ok(response) => Ok(response),
        // A dead cookie is cleared. A transient 500 must not sign anyone out.
        Err(err @ (ApiError::Unauthorized(_) | ApiError::Forbidden(_))) => {
            with_cookie(http::error_response(&err), cookie::clear())
        }
        Err(err) => Err(err),
    }
}

async fn refresh_inner<S: Sessions>(deps: &Deps<'_, S>, event: &Request) -> Result<Response<Body>> {
    let token = session_cookie(event)
        .ok_or_else(|| ApiError::unauthorized("no session cookie on a refresh request"))?;
    let tokens = deps.sessions.refresh(&token).await?;
    let response = http::json_response(
        200,
        &SessionResponse {
            id_token: &tokens.id_token,
        },
    );
    match tokens.refresh_token.as_deref() {
        Some(rotated) => with_cookie(response, cookie::set(rotated)),
        // Leave the cookie alone: Cognito's validity does not slide, so neither should Max-Age.
        None => Ok(response),
    }
}

/// Best effort. The cookie is `HttpOnly`, so failing here would leave a session nobody can end.
async fn sign_out<S: Sessions>(deps: &Deps<'_, S>, event: &Request) -> Result<Response<Body>> {
    if let Some(token) = session_cookie(event) {
        if let Err(err) = deps.sessions.revoke(&token).await {
            tracing::warn!(%err, "revoke failed; clearing the cookie anyway");
        }
    }
    with_cookie(http::no_content(), cookie::clear())
}

fn session_cookie(event: &Request) -> Option<String> {
    event
        .headers()
        .get(COOKIE)
        .and_then(|header| header.to_str().ok())
        .and_then(cookie::read)
        .map(str::to_string)
}

fn with_cookie(mut response: Response<Body>, cookie: String) -> Result<Response<Body>> {
    let value = HeaderValue::from_str(&cookie)
        .map_err(|e| ApiError::internal(format!("invalid Set-Cookie value: {e}")))?;
    response.headers_mut().insert(SET_COOKIE, value);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookie::COOKIE_NAME;
    use crate::sessions::Tokens;
    use rstest::rstest;
    use std::sync::Mutex;

    const SITE: &str = "https://familia.example.test";

    #[derive(Default)]
    struct FakeSessions {
        refuse: bool,
        deny_exchange: bool,
        rotate: bool,
        revoke_fails: bool,
        calls: Mutex<Vec<String>>,
    }

    impl FakeSessions {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn answer(&self, refresh_token: Option<&str>) -> Result<Tokens> {
            if self.refuse {
                return Err(ApiError::unauthorized("refused"));
            }
            Ok(Tokens {
                id_token: "id-token".to_string(),
                refresh_token: refresh_token.map(str::to_string),
            })
        }
    }

    impl Sessions for FakeSessions {
        async fn exchange(&self, code: &str, verifier: &str) -> Result<Tokens> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("exchange:{code}:{verifier}"));
            if self.deny_exchange {
                return Err(ApiError::forbidden("sign-in denied"));
            }
            self.answer(Some("new-refresh-token"))
        }

        async fn refresh(&self, token: &str) -> Result<Tokens> {
            self.calls.lock().unwrap().push(format!("refresh:{token}"));
            self.answer(self.rotate.then_some("rotated-token"))
        }

        async fn revoke(&self, token: &str) -> Result<()> {
            self.calls.lock().unwrap().push(format!("revoke:{token}"));
            if self.revoke_fails {
                return Err(ApiError::internal("revoke failed"));
            }
            Ok(())
        }
    }

    fn build(method: &str, path: &str, body: Option<&str>, cookie: Option<&str>) -> Request {
        let mut builder = lambda_http::http::Request::builder()
            .method(method)
            .uri(format!("{SITE}{path}"))
            .header(ORIGIN, SITE);
        if let Some(cookie) = cookie {
            builder = builder.header(COOKIE, format!("{COOKIE_NAME}={cookie}"));
        }
        let body = body.map_or(Body::Empty, |text| Body::Text(text.to_string()));
        builder.body(body).expect("valid test request")
    }

    fn mint_request() -> Request {
        build(
            "POST",
            "/api/auth/session",
            Some(r#"{"code":"the-code","codeVerifier":"the-verifier"}"#),
            None,
        )
    }

    async fn run(sessions: &FakeSessions, event: Request) -> Response<Body> {
        let deps = Deps {
            sessions,
            site_origin: SITE,
        };
        function_handler(&deps, event)
            .await
            .expect("the handler never returns Err")
    }

    fn set_cookie(response: &Response<Body>) -> Option<&str> {
        response
            .headers()
            .get(SET_COOKIE)
            .and_then(|v| v.to_str().ok())
    }

    fn body_of(response: &Response<Body>) -> serde_json::Value {
        match response.body() {
            Body::Text(text) => serde_json::from_str(text).expect("a JSON body"),
            _ => serde_json::Value::Null,
        }
    }

    #[rstest]
    #[case("POST", "/api/auth/session", Some(Route::Mint))]
    #[case("POST", "/api/auth/session/refresh", Some(Route::Refresh))]
    #[case("DELETE", "/api/auth/session", Some(Route::SignOut))]
    #[case("POST", "/main/api/auth/session", Some(Route::Mint))]
    #[case("GET", "/api/auth/session", None)]
    #[case("DELETE", "/api/auth/session/refresh", None)]
    #[case("POST", "/api/auth/session/other", None)]
    fn the_dispatch_table_matches_the_api(
        #[case] method: &str,
        #[case] path: &str,
        #[case] expected: Option<Route>,
    ) {
        assert_eq!(route_of(&method.parse().expect("a method"), path), expected);
    }

    #[tokio::test]
    async fn signing_in_returns_the_id_token_and_keeps_the_refresh_token_in_the_cookie() {
        let sessions = FakeSessions::default();
        let response = run(&sessions, mint_request()).await;

        assert_eq!(response.status(), 200);
        assert_eq!(body_of(&response)["idToken"], "id-token");
        assert_eq!(body_of(&response).get("refreshToken"), None);
        assert_eq!(
            set_cookie(&response),
            Some(cookie::set("new-refresh-token").as_str())
        );
        assert_eq!(sessions.calls(), vec!["exchange:the-code:the-verifier"]);
    }

    #[tokio::test]
    async fn a_refused_code_sets_no_cookie() {
        let sessions = FakeSessions {
            refuse: true,
            ..Default::default()
        };
        let response = run(&sessions, mint_request()).await;
        assert_eq!(response.status(), 401);
        assert_eq!(set_cookie(&response), None);
    }

    #[tokio::test]
    async fn a_removed_member_gets_a_403_and_no_cookie() {
        let sessions = FakeSessions {
            deny_exchange: true,
            ..Default::default()
        };
        let response = run(&sessions, mint_request()).await;
        assert_eq!(response.status(), 403);
        assert_eq!(body_of(&response)["error"]["code"], "forbidden");
        assert_eq!(set_cookie(&response), None);
    }

    #[tokio::test]
    async fn a_refresh_without_a_cookie_never_reaches_cognito() {
        let sessions = FakeSessions::default();
        let response = run(
            &sessions,
            build("POST", "/api/auth/session/refresh", None, None),
        )
        .await;
        assert_eq!(response.status(), 401);
        assert!(sessions.calls().is_empty());
    }

    #[tokio::test]
    async fn a_refresh_without_rotation_leaves_the_cookie_alone() {
        let sessions = FakeSessions::default();
        let event = build("POST", "/api/auth/session/refresh", None, Some("the-token"));
        let response = run(&sessions, event).await;
        assert_eq!(response.status(), 200);
        assert_eq!(set_cookie(&response), None);
    }

    #[tokio::test]
    async fn a_rotated_token_replaces_the_cookie() {
        let sessions = FakeSessions {
            rotate: true,
            ..Default::default()
        };
        let event = build("POST", "/api/auth/session/refresh", None, Some("old-token"));
        let response = run(&sessions, event).await;
        assert_eq!(
            set_cookie(&response),
            Some(cookie::set("rotated-token").as_str())
        );
    }

    #[tokio::test]
    async fn a_refused_refresh_clears_the_dead_cookie() {
        let sessions = FakeSessions {
            refuse: true,
            ..Default::default()
        };
        let event = build(
            "POST",
            "/api/auth/session/refresh",
            None,
            Some("dead-token"),
        );
        let response = run(&sessions, event).await;
        assert_eq!(response.status(), 401);
        assert_eq!(set_cookie(&response), Some(cookie::clear().as_str()));
    }

    #[rstest]
    #[case(false)]
    #[case(true)]
    #[tokio::test]
    async fn signing_out_always_clears_the_cookie(#[case] revoke_fails: bool) {
        let sessions = FakeSessions {
            revoke_fails,
            ..Default::default()
        };
        let event = build("DELETE", "/api/auth/session", None, Some("live-token"));
        let response = run(&sessions, event).await;
        assert_eq!(response.status(), 204);
        assert_eq!(set_cookie(&response), Some(cookie::clear().as_str()));
        assert_eq!(sessions.calls(), vec!["revoke:live-token"]);
    }

    #[tokio::test]
    async fn a_foreign_origin_is_refused_before_cognito_is_touched() {
        let sessions = FakeSessions::default();
        let mut event = mint_request();
        event
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        let response = run(&sessions, event).await;
        assert_eq!(response.status(), 403);
        assert!(sessions.calls().is_empty());
    }

    #[tokio::test]
    async fn every_response_is_no_store() {
        let sessions = FakeSessions {
            refuse: true,
            ..Default::default()
        };
        let response = run(&sessions, mint_request()).await;
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    }
}
