//! The table's keys, as `backend/docs/dynamodb-schema.md` lays them out.

use family_core::ddb::member_partition_key;

use super::table::Key;
use crate::model::Kind;
use crate::rules::replay::pair_key;

pub const LEDGER_PK: &str = "LEDGER#main";

fn ledger(sk: String) -> Key {
    Key::new(LEDGER_PK, sk)
}

pub fn head() -> Key {
    ledger("HEAD".to_string())
}

pub fn allowlist(email: &str) -> Key {
    Key::new(member_partition_key(email), "PROFILE")
}

pub fn account(email: &str) -> Key {
    Key::new(format!("ACCOUNT#{}", email.trim().to_lowercase()), "LINK")
}

pub fn member(id: &str) -> Key {
    ledger(format!("PROFILE#{id}"))
}

pub fn group(id: &str) -> Key {
    ledger(format!("GROUP#{id}"))
}

pub fn expense(id: &str) -> Key {
    ledger(format!("EXPENSE#{id}"))
}

pub fn payment(id: &str) -> Key {
    ledger(format!("PAYMENT#{id}"))
}

pub fn rate(id: &str) -> Key {
    ledger(format!("RATE#{id}"))
}

pub fn pair(x: &str, y: &str) -> Key {
    let (low, high) = pair_key(x, y);
    ledger(format!("PAIR#{low}#{high}"))
}

pub fn allocation_prefix(x: &str, y: &str) -> String {
    let (low, high) = pair_key(x, y);
    format!("ALLOC#{low}#{high}#")
}

pub fn allocation(x: &str, y: &str, year: &str) -> Key {
    ledger(format!("{}{year}", allocation_prefix(x, y)))
}

/// The sort key of a list entry: newest first when read in descending order.
pub fn entry_sort_key(date: &str, seq: u64) -> String {
    format!("{date}#{seq:08}")
}

pub fn group_expenses_pk(group_id: &str) -> String {
    format!("GROUP#{group_id}#EXPENSES")
}

pub fn group_kind_pk(group_id: &str, kind: Kind) -> String {
    format!("GROUP#{group_id}#KIND#{}", kind.as_str())
}

pub fn pair_payments_pk(x: &str, y: &str) -> String {
    let (low, high) = pair_key(x, y);
    format!("PAIR#{low}#{high}#PAYMENTS")
}
