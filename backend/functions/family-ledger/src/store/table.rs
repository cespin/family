//! The storage operations the ledger needs. Every read is strongly consistent.

use std::future::Future;

use family_core::{ApiError, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

pub type Item = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key {
    pub pk: String,
    pub sk: String,
}

impl Key {
    pub fn new(pk: impl Into<String>, sk: impl Into<String>) -> Self {
        Self {
            pk: pk.into(),
            sk: sk.into(),
        }
    }

    pub fn of(item: &Item) -> Result<Self> {
        match (
            item.get("PK").and_then(Value::as_str),
            item.get("SK").and_then(Value::as_str),
        ) {
            (Some(pk), Some(sk)) => Ok(Self::new(pk, sk)),
            _ => Err(ApiError::internal("an item has no key")),
        }
    }
}

/// One page of a partition, optionally limited to a sort key prefix or to keys before a position.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageQuery {
    pub pk: String,
    pub prefix: Option<String>,
    /// Only sort keys strictly below this one.
    pub before: Option<String>,
    pub descending: bool,
    pub limit: Option<usize>,
    pub start_after: Option<Key>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Page {
    pub items: Vec<Item>,
    pub next: Option<Key>,
}

/// A condition on the item an operation targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guard {
    None,
    Absent,
    Exists,
    /// The item is at this revision. Revision 0 means the item does not exist yet.
    Rev(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub enum TxOp {
    Put { item: Item, guard: Guard },
    Check { key: Key, guard: Guard },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    None,
    GuardFailed,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxOutcome {
    Committed,
    /// One reason per operation, in order.
    Cancelled(Vec<CancelReason>),
}

pub trait Table: Send + Sync {
    fn get(&self, key: &Key) -> impl Future<Output = Result<Option<Item>>> + Send;
    /// Returns every item that exists, in no particular order.
    fn batch_get(&self, keys: &[Key]) -> impl Future<Output = Result<Vec<Item>>> + Send;
    fn query_page(&self, query: &PageQuery) -> impl Future<Output = Result<Page>> + Send;
    fn transact(&self, ops: Vec<TxOp>) -> impl Future<Output = Result<TxOutcome>> + Send;
}

/// Reads an item into its model type.
pub fn from_item<T: DeserializeOwned>(item: &Item) -> Result<T> {
    serde_json::from_value(Value::Object(item.clone()))
        .map_err(|e| ApiError::internal(format!("a stored item could not be read: {e}")))
}

/// Builds an item from its model type, stamped with the revision of this write.
pub fn to_item<T: Serialize>(key: &Key, value: &T, rev: u64) -> Result<Item> {
    let Value::Object(mut item) = serde_json::to_value(value)
        .map_err(|e| ApiError::internal(format!("an item could not be written: {e}")))?
    else {
        return Err(ApiError::internal("an item is not an object"));
    };
    item.insert("PK".to_string(), Value::from(key.pk.clone()));
    item.insert("SK".to_string(), Value::from(key.sk.clone()));
    item.insert("rev".to_string(), Value::from(rev));
    Ok(item)
}

/// An item that no longer applies. It is overwritten rather than deleted, so that a read caught in
/// the middle of the write can notice.
pub fn retired_item(key: &Key, rev: u64) -> Item {
    let mut item = Item::new();
    item.insert("PK".to_string(), Value::from(key.pk.clone()));
    item.insert("SK".to_string(), Value::from(key.sk.clone()));
    item.insert("removed".to_string(), Value::from(true));
    item.insert("rev".to_string(), Value::from(rev));
    item
}

pub fn is_retired(item: &Item) -> bool {
    item.get("removed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn rev_of(item: &Item) -> u64 {
    item.get("rev").and_then(Value::as_u64).unwrap_or(0)
}
