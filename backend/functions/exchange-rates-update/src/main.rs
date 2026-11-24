//! Updates the exchange rates in the background. `ledger-read` invokes it asynchronously, with
//! invocation type `Event`, when the last check is older than six hours. Its event carries nothing
//! it needs, and the stack turns retries off: the next ledger read tries again.

use aws_config::BehaviorVersion;
use family_core::config::required_env;
use family_ledger::service::env::SystemEnv;
use family_ledger::service::rates::{refresh, Requester};
use family_ledger::store::dynamo::DynamoTable;
use family_rates::PublicRates;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_runtime::tracing::init_default_subscriber();
    let table_name = required_env("TABLE_NAME")?;
    let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let table = DynamoTable::new(aws_sdk_dynamodb::Client::new(&shared), table_name);
    let (table, fetcher, env) = (&table, &PublicRates::default(), &SystemEnv);
    run(service_fn(move |_: LambdaEvent<Value>| async move {
        // A failure is logged rather than raised: a retry would only ask the services again.
        match refresh(table, fetcher, env, Requester::Background).await {
            Ok(outcome) => tracing::info!("exchange rate update: {outcome:?}"),
            Err(error) => tracing::warn!("exchange rate update failed: {error}"),
        }
        Ok::<_, Error>(())
    }))
    .await
}
