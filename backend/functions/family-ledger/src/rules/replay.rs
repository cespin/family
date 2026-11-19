//! Rebuilds pair state from the full history. A replay is the definition of the correct state.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use family_core::Result;

use crate::model::{AllocationSlice, Expense, Payment};
use crate::rules::pair::PairState;

/// Two members, lower identifier first.
pub fn pair_key(x: &str, y: &str) -> (String, String) {
    if x < y {
        (x.to_string(), y.to_string())
    } else {
        (y.to_string(), x.to_string())
    }
}

/// The pairs of members an expense creates a debt between.
pub fn pairs_of_expense(expense: &Expense) -> BTreeSet<(String, String)> {
    expense
        .shares
        .iter()
        .filter(|(id, share)| **id != expense.payer_id && **share > 0)
        .map(|(id, _)| pair_key(id, &expense.payer_id))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairHistory {
    pub state: PairState,
    pub slices: Vec<AllocationSlice>,
}

enum Event<'a> {
    Expense(&'a Expense),
    Payment(&'a Payment),
}

impl Event<'_> {
    fn seq(&self) -> u64 {
        match self {
            Self::Expense(expense) => expense.seq,
            Self::Payment(payment) => payment.seq,
        }
    }
}

/// Replays one pair, in the order events were recorded.
pub fn replay_pair(
    low: &str,
    high: &str,
    expenses: &[Expense],
    payments: &[Payment],
) -> Result<PairHistory> {
    let key = (low.to_string(), high.to_string());
    let mut events: Vec<Event> = expenses
        .iter()
        .filter(|expense| pairs_of_expense(expense).contains(&key))
        .map(Event::Expense)
        .chain(
            payments
                .iter()
                .filter(|payment| pair_key(&payment.from_id, &payment.to_id) == key)
                .map(Event::Payment),
        )
        .collect();
    events.sort_by_key(Event::seq);

    let index: HashMap<String, Payment> = payments
        .iter()
        .map(|payment| (payment.id.clone(), payment.clone()))
        .collect();
    let mut state = PairState::new(low, high);
    let mut slices = Vec::new();
    for event in events {
        slices.extend(match event {
            Event::Expense(expense) => state.apply_expense(expense, &index)?,
            Event::Payment(payment) => state.apply_payment(payment)?,
        });
    }
    Ok(PairHistory { state, slices })
}

/// Replays every pair that has any history.
pub fn replay_all(
    expenses: &[Expense],
    payments: &[Payment],
) -> Result<BTreeMap<(String, String), PairHistory>> {
    let mut keys: BTreeSet<(String, String)> = expenses.iter().flat_map(pairs_of_expense).collect();
    keys.extend(
        payments
            .iter()
            .map(|payment| pair_key(&payment.from_id, &payment.to_id)),
    );
    keys.into_iter()
        .map(|(low, high)| {
            let history = replay_pair(&low, &high, expenses, payments)?;
            Ok(((low, high), history))
        })
        .collect()
}

/// Groups slices into the yearly allocation items, by the year of the expense each one covers.
pub fn slices_by_year(
    slices: &[AllocationSlice],
    expense_dates: &HashMap<String, String>,
) -> BTreeMap<String, Vec<AllocationSlice>> {
    let mut years: BTreeMap<String, Vec<AllocationSlice>> = BTreeMap::new();
    for slice in slices {
        let year = expense_dates
            .get(&slice.expense_id)
            .map_or("", |date| &date[..4]);
        years
            .entry(year.to_string())
            .or_default()
            .push(slice.clone());
    }
    years
}
