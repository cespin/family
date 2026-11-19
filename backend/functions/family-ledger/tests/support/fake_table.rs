//! An in-memory table that refuses what DynamoDB refuses, with hooks for interleaving writes.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Mutex;

use family_core::{ApiError, Result};
use family_ledger::store::table::{
    rev_of, CancelReason, Guard, Item, Key, Page, PageQuery, Table, TxOp, TxOutcome,
};

use super::fixtures::Items;

type Hook = Box<dyn FnOnce(&mut Items) + Send>;

#[derive(Default)]
pub struct FakeTable {
    items: Mutex<Items>,
    /// Runs just before the numbered read, counting from 1.
    hooks: Mutex<BTreeMap<usize, Hook>>,
    /// Runs just before the next transaction is evaluated.
    commit_hook: Mutex<Option<Hook>>,
    reads: Mutex<usize>,
    cancellations: Mutex<VecDeque<Vec<CancelReason>>>,
    failing_from: Mutex<Option<usize>>,
    pub transactions: Mutex<usize>,
}

impl FakeTable {
    pub fn seeded(items: Items) -> Self {
        Self {
            items: Mutex::new(items),
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> Items {
        self.items.lock().unwrap().clone()
    }

    pub fn before_read(&self, number: usize, hook: impl FnOnce(&mut Items) + Send + 'static) {
        self.hooks.lock().unwrap().insert(number, Box::new(hook));
    }

    pub fn before_commit(&self, hook: impl FnOnce(&mut Items) + Send + 'static) {
        *self.commit_hook.lock().unwrap() = Some(Box::new(hook));
    }

    pub fn cancel_next(&self, reasons: Vec<CancelReason>) {
        self.cancellations.lock().unwrap().push_back(reasons);
    }

    /// Every read from this one on fails.
    pub fn fail_from_read(&self, number: usize) {
        *self.failing_from.lock().unwrap() = Some(number);
    }

    fn on_read(&self) -> Result<()> {
        let number = {
            let mut reads = self.reads.lock().unwrap();
            *reads += 1;
            *reads
        };
        if self
            .failing_from
            .lock()
            .unwrap()
            .is_some_and(|from| number >= from)
        {
            return Err(ApiError::internal("the table is unavailable"));
        }
        if let Some(hook) = self.hooks.lock().unwrap().remove(&number) {
            hook(&mut self.items.lock().unwrap());
        }
        Ok(())
    }
}

fn holds(guard: Guard, item: Option<&Item>) -> bool {
    match guard {
        Guard::None => true,
        Guard::Absent | Guard::Rev(0) => item.is_none(),
        Guard::Exists => item.is_some(),
        Guard::Rev(rev) => item.is_some_and(|item| rev_of(item) == rev),
    }
}

impl Table for FakeTable {
    async fn get(&self, key: &Key) -> Result<Option<Item>> {
        self.on_read()?;
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(&(key.pk.clone(), key.sk.clone()))
            .cloned())
    }

    async fn batch_get(&self, keys: &[Key]) -> Result<Vec<Item>> {
        self.on_read()?;
        let unique: HashSet<&Key> = keys.iter().collect();
        assert_eq!(
            unique.len(),
            keys.len(),
            "DynamoDB refuses repeated keys in a batch"
        );
        let items = self.items.lock().unwrap();
        Ok(keys
            .iter()
            .filter_map(|key| items.get(&(key.pk.clone(), key.sk.clone())).cloned())
            .collect())
    }

    async fn query_page(&self, query: &PageQuery) -> Result<Page> {
        self.on_read()?;
        let items = self.items.lock().unwrap();
        let mut found: Vec<&Item> = items
            .iter()
            .filter(|((pk, sk), _)| {
                *pk == query.pk
                    && query
                        .prefix
                        .as_ref()
                        .is_none_or(|prefix| sk.starts_with(prefix))
                    && query.before.as_ref().is_none_or(|before| sk < before)
            })
            .map(|(_, item)| item)
            .collect();
        if query.descending {
            found.reverse();
        }
        if let Some(start) = &query.start_after {
            let position = found
                .iter()
                .position(|item| Key::of(item).unwrap() == *start);
            found.drain(..=position.expect("the start key was returned earlier"));
        }
        let limit = query.limit.unwrap_or(found.len());
        let more = found.len() > limit;
        found.truncate(limit);
        let next = if more {
            found.last().map(|item| Key::of(item).unwrap())
        } else {
            None
        };
        Ok(Page {
            items: found.into_iter().cloned().collect(),
            next,
        })
    }

    async fn transact(&self, ops: Vec<TxOp>) -> Result<TxOutcome> {
        *self.transactions.lock().unwrap() += 1;
        assert!(
            ops.len() <= 100,
            "DynamoDB refuses more than 100 actions in a transaction"
        );
        let key_of = |op: &TxOp| match op {
            TxOp::Put { item, .. } => Key::of(item).unwrap(),
            TxOp::Check { key, .. } => key.clone(),
        };
        let unique: HashSet<Key> = ops.iter().map(key_of).collect();
        assert_eq!(
            unique.len(),
            ops.len(),
            "DynamoDB refuses two actions on one item"
        );

        if let Some(reasons) = self.cancellations.lock().unwrap().pop_front() {
            return Ok(TxOutcome::Cancelled(reasons));
        }
        let mut items = self.items.lock().unwrap();
        if let Some(hook) = self.commit_hook.lock().unwrap().take() {
            hook(&mut items);
        }
        let reasons: Vec<CancelReason> = ops
            .iter()
            .map(|op| {
                let key = key_of(op);
                let current = items.get(&(key.pk, key.sk));
                let guard = match op {
                    TxOp::Put { guard, .. } | TxOp::Check { guard, .. } => *guard,
                };
                if holds(guard, current) {
                    CancelReason::None
                } else {
                    CancelReason::GuardFailed
                }
            })
            .collect();
        if reasons.contains(&CancelReason::GuardFailed) {
            return Ok(TxOutcome::Cancelled(reasons));
        }
        for op in ops {
            if let TxOp::Put { item, .. } = op {
                let key = Key::of(&item).unwrap();
                items.insert((key.pk, key.sk), item);
            }
        }
        Ok(TxOutcome::Committed)
    }
}
