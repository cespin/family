//! Gives every expense and payment saved before transaction dates existed one transaction date.
//! Run it through `backend/scripts/backfill-transaction-date.sh`, which resolves the table and
//! sets the AWS profile and region from its mandatory arguments.
//!
//! Usage: backfill-transaction-date --table <name> --date <YYYY-MM-DD> [--dry-run]
//!        [--endpoint-url <url>]

use std::process::ExitCode;

use aws_config::BehaviorVersion;
use family_ledger::service::backfill::transaction_dates;
use family_ledger::store::dynamo::DynamoTable;

const USAGE: &str = "Usage: backfill-transaction-date --table <name> --date <YYYY-MM-DD> \
                     [--dry-run] [--endpoint-url <url>]";

#[derive(Default)]
struct Arguments {
    table: Option<String>,
    date: Option<String>,
    dry_run: bool,
    endpoint_url: Option<String>,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Arguments, String> {
    let mut parsed = Arguments::default();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--table" => parsed.table = Some(value()?),
            "--date" => parsed.date = Some(value()?),
            "--endpoint-url" => parsed.endpoint_url = Some(value()?),
            "--dry-run" => parsed.dry_run = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(parsed)
}

#[tokio::main]
async fn main() -> ExitCode {
    let arguments = match parse(std::env::args().skip(1)) {
        Ok(arguments) => arguments,
        Err(problem) => {
            eprintln!("error: {problem}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let (Some(table_name), Some(date)) = (arguments.table, arguments.date) else {
        eprintln!("error: --table and --date are required\n{USAGE}");
        return ExitCode::from(2);
    };

    let mut config = aws_config::defaults(BehaviorVersion::latest());
    if let Some(url) = arguments.endpoint_url {
        config = config.endpoint_url(url);
    }
    let client = aws_sdk_dynamodb::Client::new(&config.load().await);
    let table = DynamoTable::new(client, table_name);

    match transaction_dates(&table, &date, arguments.dry_run).await {
        Ok(done) => {
            let verb = if arguments.dry_run {
                "Would backfill"
            } else {
                "Backfilled"
            };
            println!(
                "==> {verb} {} expenses and {} payments with {date}",
                done.expenses, done.payments
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error:?}");
            ExitCode::FAILURE
        }
    }
}
