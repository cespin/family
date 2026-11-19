//! The one-time backfill that gives a transaction date to every expense and payment saved before
//! transaction dates existed, as "Backfilling transaction dates" in
//! `backend/docs/dynamodb-schema.md` describes.

use family_core::{ApiError, Result};

use crate::consistent_read;
use crate::model::{Expense, ExpenseEntry, Payment, PaymentEntry};
use crate::protocol::write::{commit_as_operator, Commit};
use crate::rules::validate::require_date;
use crate::service::expenses::{group_entry_key, kind_entry_key};
use crate::service::payments::entry_key;
use crate::service::reads::{read_expense, read_payment};
use crate::store::keys;
use crate::store::table::{retired_item, to_item, Item, Key, Table};

/// How many writes in a row may lose to other writes before the backfill gives up.
const CONTENDED_TRIES: usize = 5;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Backfilled {
    pub expenses: usize,
    pub payments: usize,
}

enum Pending {
    Expense(Expense),
    Payment(Payment),
}

/// Every expense and payment that has no transaction date yet, read at one revision.
async fn pending<T: Table>(table: &T) -> Result<(u64, Vec<Pending>)> {
    Ok(consistent_read!(table, session, {
        let mut pending = Vec::new();
        for item in session.ledger_prefix("EXPENSE#").await? {
            let id = Key::of(&item)?.sk["EXPENSE#".len()..].to_string();
            let expense = read_expense(&item, &id)?;
            if expense.transaction_date.is_none() {
                pending.push(Pending::Expense(expense));
            }
        }
        for item in session.ledger_prefix("PAYMENT#").await? {
            let id = Key::of(&item)?.sk["PAYMENT#".len()..].to_string();
            let payment = read_payment(&item, &id)?;
            if payment.transaction_date.is_none() {
                pending.push(Pending::Payment(payment));
            }
        }
        pending
    }))
}

/// The item, its list entries at their new place, and the old entries retired.
fn moved_items(pending: &Pending, date: &str, rev: u64) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    match pending {
        Pending::Expense(old) => {
            let new = Expense {
                transaction_date: Some(date.to_string()),
                ..old.clone()
            };
            items.push(to_item(&keys::expense(&new.id), &new, rev)?);
            let entry = ExpenseEntry::from(&new);
            for (old_key, new_key) in [
                (group_entry_key(old), group_entry_key(&new)),
                (kind_entry_key(old), kind_entry_key(&new)),
            ] {
                if old_key != new_key {
                    items.push(retired_item(&old_key, rev));
                }
                items.push(to_item(&new_key, &entry, rev)?);
            }
        }
        Pending::Payment(old) => {
            let new = Payment {
                transaction_date: Some(date.to_string()),
                ..old.clone()
            };
            items.push(to_item(&keys::payment(&new.id), &new, rev)?);
            let (old_key, new_key) = (entry_key(old), entry_key(&new));
            if old_key != new_key {
                items.push(retired_item(&old_key, rev));
            }
            items.push(to_item(&new_key, &PaymentEntry::from(&new), rev)?);
        }
    }
    Ok(items)
}

/// Gives `date` as the transaction date to every expense and payment without one, one write each,
/// and moves their list entries to that date. Items that already have one are left alone, so
/// running it again changes nothing. With `dry_run` it only counts what it would change.
pub async fn transaction_dates<T: Table>(
    table: &T,
    date: &str,
    dry_run: bool,
) -> Result<Backfilled> {
    require_date(date)?;
    let mut done = Backfilled::default();
    let mut contended = 0;
    loop {
        let (mut rev, pending) = pending(table).await?;
        if dry_run || pending.is_empty() {
            for item in &pending {
                match item {
                    Pending::Expense(_) => done.expenses += 1,
                    Pending::Payment(_) => done.payments += 1,
                }
            }
            return Ok(done);
        }
        for item in &pending {
            match commit_as_operator(table, rev, moved_items(item, date, rev + 1)?).await? {
                Commit::Saved => {
                    rev += 1;
                    contended = 0;
                    match item {
                        Pending::Expense(_) => done.expenses += 1,
                        Pending::Payment(_) => done.payments += 1,
                    }
                }
                // Someone else wrote first, so what was read may be stale: read it all again.
                Commit::Contended => {
                    contended += 1;
                    if contended >= CONTENDED_TRIES {
                        return Err(ApiError::conflict(
                            "The ledger kept changing during the backfill. Run it again.",
                        ));
                    }
                    break;
                }
            }
        }
    }
}
