//! PUT /api/me/profile. The logic lives in `family-ledger`.

use aws_config::BehaviorVersion;
use family_core::config::required_env;
use family_ledger::api;
use family_ledger::service::env::SystemEnv;
use family_ledger::store::dynamo::DynamoTable;
use lambda_http::{run, service_fn, Error, Request};

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_http::tracing::init_default_subscriber();
    let table_name = required_env("TABLE_NAME")?;
    let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let table = DynamoTable::new(aws_sdk_dynamodb::Client::new(&shared), table_name);
    let table = &table;
    run(service_fn(move |event: Request| async move {
        Ok::<_, Error>(api::me_profile_put(table, &SystemEnv, &event).await)
    }))
    .await
}
