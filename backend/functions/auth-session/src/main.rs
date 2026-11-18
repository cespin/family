//! The session cookie routes. See [`http_handler`] for the routes and [`cookie`] for the contract.

use family_core::config::required_env;
use lambda_http::{run, service_fn, Error, Request};

mod cookie;
mod http_handler;
mod sessions;

use http_handler::{function_handler, Deps};
use sessions::CognitoSessions;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // The default subscriber logs neither headers nor bodies, which keeps tokens out of the logs.
    lambda_http::tracing::init_default_subscriber();

    let site_origin = required_env("SITE_ORIGIN")?;
    let sessions = CognitoSessions::new(
        required_env("COGNITO_DOMAIN")?,
        required_env("USER_POOL_CLIENT_ID")?,
        &site_origin,
    );
    let deps = Deps {
        sessions: &sessions,
        site_origin: &site_origin,
    };
    let deps = &deps;
    run(service_fn(move |event: Request| async move {
        function_handler(deps, event).await
    }))
    .await
}
