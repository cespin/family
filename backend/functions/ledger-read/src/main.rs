//! GET /api/ledger, /api/expenses, /api/expenses/{expenseId} and /api/payments. The logic lives in
//! `family-ledger`. A ledger read that finds the exchange rates stale starts `exchange-rates-update`
//! through [`LambdaUpdate`].

use aws_config::BehaviorVersion;
use aws_sdk_lambda::operation::invoke::builders::InvokeFluentBuilder;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use family_core::config::required_env;
use family_core::{ApiError, Result};
use family_ledger::api;
use family_ledger::service::env::SystemEnv;
use family_ledger::service::rates::RatesUpdate;
use family_ledger::store::dynamo::DynamoTable;
use lambda_http::{run, service_fn, Error, Request};

/// Starts the update function without waiting for it.
struct LambdaUpdate {
    client: aws_sdk_lambda::Client,
    function: String,
}

/// Always invocation type `Event`, never `RequestResponse`: Lambda queues the event and answers 202
/// at once, so a ledger read never waits for the rate services. The update needs nothing from the
/// event, but an empty JSON object keeps its runtime's deserializer satisfied.
fn invocation(client: &aws_sdk_lambda::Client, function: &str) -> InvokeFluentBuilder {
    client
        .invoke()
        .function_name(function)
        .invocation_type(InvocationType::Event)
        .payload(Blob::new("{}"))
}

impl RatesUpdate for LambdaUpdate {
    async fn start(&self) -> Result<()> {
        let answer = invocation(&self.client, &self.function)
            .send()
            .await
            .map_err(|e| ApiError::internal(format!("the update could not be queued: {e}")))?;
        tracing::info!(
            "queued the exchange rate update: HTTP {}",
            answer.status_code()
        );
        Ok(())
    }
}

#[tokio::main]
async fn main() -> std::result::Result<(), Error> {
    lambda_http::tracing::init_default_subscriber();
    let table_name = required_env("TABLE_NAME")?;
    let function = required_env("RATES_UPDATE_FUNCTION")?;
    let shared = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let table = DynamoTable::new(aws_sdk_dynamodb::Client::new(&shared), table_name);
    let update = LambdaUpdate {
        client: aws_sdk_lambda::Client::new(&shared),
        function,
    };
    let (table, update, env) = (&table, &update, &SystemEnv);
    run(service_fn(move |event: Request| async move {
        Ok::<_, Error>(api::ledger_read(table, env, update, &event).await)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_lambda::config::{BehaviorVersion, Region};

    #[test]
    fn the_update_is_always_an_asynchronous_invocation() {
        let config = aws_sdk_lambda::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("local"))
            .build();
        let client = aws_sdk_lambda::Client::from_conf(config);
        let request = invocation(&client, "update");
        assert_eq!(request.get_invocation_type(), &Some(InvocationType::Event));
        assert_eq!(request.get_function_name().as_deref(), Some("update"));
        let payload = request
            .get_payload()
            .as_ref()
            .map(|blob| blob.as_ref().to_vec());
        assert_eq!(payload.as_deref(), Some(&b"{}"[..]));
    }
}
