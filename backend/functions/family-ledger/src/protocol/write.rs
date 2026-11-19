//! Saving a change: one transaction that also moves the head, so concurrent writes cannot both land.

use family_core::{ApiError, Result};
use serde_json::{json, Value};

use crate::store::keys;
use crate::store::table::{CancelReason, Guard, Item, Key, Table, TxOp, TxOutcome};

pub const WRITE_TRIES: usize = 3;

/// The items one write changes.
#[derive(Debug, Default)]
pub struct WritePlan {
    /// Ledger items, each already stamped with the new revision.
    pub items: Vec<Item>,
    /// Items outside the ledger's revisions, such as the account link.
    pub unstamped: Vec<(Item, Guard)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Commit {
    Saved,
    /// Another write got there first, so the caller reads again and retries.
    Contended,
}

/// Sends the transaction for a write based on what was read at `rev`.
pub async fn commit<T: Table>(table: &T, rev: u64, email: &str, plan: WritePlan) -> Result<Commit> {
    let last_write = plan
        .items
        .iter()
        .map(|item| {
            let key = Key::of(item)?;
            Ok(json!({ "PK": key.pk, "SK": key.sk }))
        })
        .collect::<Result<Vec<Value>>>()?;

    let head = keys::head();
    let mut head_item = Item::new();
    head_item.insert("PK".to_string(), Value::from(head.pk));
    head_item.insert("SK".to_string(), Value::from(head.sk));
    head_item.insert("rev".to_string(), Value::from(rev + 1));
    head_item.insert("lastWrite".to_string(), Value::Array(last_write));

    let mut ops = vec![
        TxOp::Put {
            item: head_item,
            guard: Guard::Rev(rev),
        },
        TxOp::Check {
            key: keys::allowlist(email),
            guard: Guard::Exists,
        },
    ];
    ops.extend(plan.items.into_iter().map(|item| TxOp::Put {
        item,
        guard: Guard::None,
    }));
    ops.extend(
        plan.unstamped
            .into_iter()
            .map(|(item, guard)| TxOp::Put { item, guard }),
    );

    match table.transact(ops).await? {
        TxOutcome::Committed => Ok(Commit::Saved),
        TxOutcome::Cancelled(reasons) => {
            if reasons.get(1) == Some(&CancelReason::GuardFailed) {
                return Err(ApiError::forbidden(
                    "the caller left the allowlist during a write",
                ));
            }
            Ok(Commit::Contended)
        }
    }
}

/// What a write answers when it kept losing to other writes.
pub fn kept_losing() -> ApiError {
    ApiError::conflict("The ledger changed while saving. Try again.")
}
