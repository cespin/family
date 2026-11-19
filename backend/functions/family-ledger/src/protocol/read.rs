//! Reads that come from one point in time. DynamoDB's queries can see part of a transaction that
//! is still in flight, so a session compares the head before and after and checks what it read.

use std::collections::HashMap;

use family_core::Result;
use serde_json::Value;

use crate::store::keys;
use crate::store::table::{rev_of, Item, Key, Page, PageQuery, Table};

pub const READ_TRIES: usize = 3;

/// The ledger head. A table with no head yet is at revision 0.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Head {
    pub rev: u64,
    pub last_write: Vec<Key>,
}

pub async fn read_head<T: Table>(table: &T) -> Result<Head> {
    let Some(item) = table.get(&keys::head()).await? else {
        return Ok(Head::default());
    };
    let last_write = item
        .get("lastWrite")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(|key| {
                    Some(Key::new(key.get("PK")?.as_str()?, key.get("SK")?.as_str()?))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Head {
        rev: rev_of(&item),
        last_write,
    })
}

/// One attempt at a consistent read. Every item read through it is remembered and checked.
pub struct ReadSession<'a, T: Table> {
    table: &'a T,
    head: Head,
    seen: HashMap<Key, u64>,
}

impl<'a, T: Table> ReadSession<'a, T> {
    pub async fn begin(table: &'a T) -> Result<Self> {
        Ok(Self {
            table,
            head: read_head(table).await?,
            seen: HashMap::new(),
        })
    }

    pub fn rev(&self) -> u64 {
        self.head.rev
    }

    fn remember(&mut self, item: &Item) -> Result<()> {
        self.seen.insert(Key::of(item)?, rev_of(item));
        Ok(())
    }

    pub async fn get(&mut self, key: &Key) -> Result<Option<Item>> {
        let item = self.table.get(key).await?;
        if let Some(item) = &item {
            self.remember(item)?;
        }
        Ok(item)
    }

    pub async fn batch_get(&mut self, keys: &[Key]) -> Result<Vec<Item>> {
        let items = self.table.batch_get(keys).await?;
        for item in &items {
            self.remember(item)?;
        }
        Ok(items)
    }

    pub async fn query_page(&mut self, query: &PageQuery) -> Result<Page> {
        let page = self.table.query_page(query).await?;
        for item in &page.items {
            self.remember(item)?;
        }
        Ok(page)
    }

    /// Reads every page of a query.
    pub async fn query_all(&mut self, query: PageQuery) -> Result<Vec<Item>> {
        let mut query = query;
        let mut items = Vec::new();
        loop {
            let page = self.query_page(&query).await?;
            items.extend(page.items);
            match page.next {
                Some(next) => query.start_after = Some(next),
                None => return Ok(items),
            }
        }
    }

    /// Every ledger item whose sort key starts with `prefix`.
    pub async fn ledger_prefix(&mut self, prefix: &str) -> Result<Vec<Item>> {
        self.query_all(PageQuery {
            pk: keys::LEDGER_PK.to_string(),
            prefix: Some(prefix.to_string()),
            ..PageQuery::default()
        })
        .await
    }

    /// Whether what was read is one point in time. If not, the caller starts a new session.
    pub async fn is_consistent(self) -> Result<bool> {
        let after = read_head(self.table).await?;
        if after.rev != self.head.rev {
            return Ok(false);
        }
        let missing: Vec<Key> = after
            .last_write
            .iter()
            .filter(|key| !self.seen.contains_key(*key))
            .cloned()
            .collect();
        let mut written: HashMap<Key, u64> = HashMap::new();
        if !missing.is_empty() {
            for item in self.table.batch_get(&missing).await? {
                written.insert(Key::of(&item)?, rev_of(&item));
            }
        }
        let rev = self.head.rev;
        let landed = after
            .last_write
            .iter()
            .all(|key| self.seen.get(key).or_else(|| written.get(key)) == Some(&rev));
        Ok(landed && self.seen.values().all(|seen| *seen <= rev))
    }
}

/// Runs `$body` in a read session until it reads one point in time, or fails. A failed read is
/// never returned as partial data.
#[macro_export]
macro_rules! consistent_read {
    ($table:expr, $session:ident, $body:expr) => {{
        let mut tries = 0;
        loop {
            tries += 1;
            #[allow(unused_mut)]
            let mut $session = $crate::protocol::read::ReadSession::begin($table).await?;
            let rev = $session.rev();
            let value = $body;
            if $session.is_consistent().await? {
                break (rev, value);
            }
            if tries >= $crate::protocol::read::READ_TRIES {
                return Err(family_core::ApiError::internal(
                    "the ledger kept changing during a read",
                ));
            }
        }
    }};
}
