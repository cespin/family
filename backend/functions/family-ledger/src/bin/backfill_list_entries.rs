//! Rewrites every expense's list entries that differ from the ones it writes today, such as
//! entries saved before they carried shares. Run it through
//! `backend/scripts/backfill-list-entries.sh`, which resolves the table and sets the AWS profile
//! and region from its mandatory arguments.
//!
//! Usage: backfill-list-entries --table <name> [--dry-run] [--endpoint-url <url>]

use std::process::ExitCode;

use aws_config::BehaviorVersion;
use family_ledger::service::backfill::list_entries;
use family_ledger::store::dynamo::DynamoTable;

const USAGE: &str =
    "Usage: backfill-list-entries --table <name> [--dry-run] [--endpoint-url <url>]";

#[derive(Default)]
struct Arguments {
    table: Option<String>,
    dry_run: bool,
    endpoint_url: Option<String>,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Arguments, String> {
    let mut parsed = Arguments::default();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--table" => parsed.table = Some(value()?),
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
    let Some(table_name) = arguments.table else {
        eprintln!("error: --table is required\n{USAGE}");
        return ExitCode::from(2);
    };

    let mut config = aws_config::defaults(BehaviorVersion::latest());
    if let Some(url) = arguments.endpoint_url {
        config = config.endpoint_url(url);
    }
    let client = aws_sdk_dynamodb::Client::new(&config.load().await);
    let table = DynamoTable::new(client, table_name);

    match list_entries(&table, arguments.dry_run).await {
        Ok(done) => {
            let verb = if arguments.dry_run {
                "Would rewrite"
            } else {
                "Rewrote"
            };
            println!("==> {verb} the list entries of {done} expenses");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error:?}");
            ExitCode::FAILURE
        }
    }
}
