//! What the balances mean for one member.

use std::collections::BTreeMap;

use crate::model::{Debt, Expense};
use crate::rules::money::Currency;
use crate::rules::pair::PairState;
use crate::rules::replay::pair_key;

pub type Pairs = BTreeMap<(String, String), PairState>;

/// An amount owed between `me` and another member, positive when they owe `me`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingEntry {
    pub group_id: Option<String>,
    pub currency: Currency,
    pub amount_minor: i64,
}

/// What is open between `me` and each other member, in the original currencies.
pub fn standings_for(pairs: &Pairs, me: &str) -> BTreeMap<String, Vec<StandingEntry>> {
    let mut rows = BTreeMap::new();
    for pair in pairs
        .values()
        .filter(|pair| pair.low == me || pair.high == me)
    {
        let (other, sign) = if pair.low == me {
            (&pair.high, 1)
        } else {
            (&pair.low, -1)
        };
        let entries: Vec<StandingEntry> = pair
            .balances()
            .into_iter()
            .map(|balance| StandingEntry {
                group_id: balance.group_id,
                currency: balance.currency,
                amount_minor: sign * balance.amount_minor,
            })
            .collect();
        if !entries.is_empty() {
            rows.insert(other.clone(), entries);
        }
    }
    rows
}

/// The open debt on one expense between two members. A closed debt has left the list.
pub fn open_debt<'a>(pairs: &'a Pairs, expense_id: &str, x: &str, y: &str) -> Option<&'a Debt> {
    pairs
        .get(&pair_key(x, y))?
        .open_debts
        .iter()
        .find(|debt| debt.expense_id == expense_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseStanding {
    pub involved: bool,
    pub open_minor: Option<i64>,
    pub settled: bool,
}

/// What one expense means for `me`.
pub fn expense_standing(
    pairs: &Pairs,
    expense_id: &str,
    payer_id: &str,
    participant_ids: &[String],
    me: &str,
) -> ExpenseStanding {
    if payer_id == me {
        let others: Vec<&String> = participant_ids
            .iter()
            .filter(|id| *id != payer_id)
            .collect();
        let open_minor: i64 = others
            .iter()
            .filter_map(|id| open_debt(pairs, expense_id, me, id))
            .map(|debt| debt.remaining_minor.abs())
            .sum();
        let any_open = others
            .iter()
            .any(|id| open_debt(pairs, expense_id, me, id).is_some());
        return ExpenseStanding {
            involved: true,
            open_minor: Some(open_minor),
            settled: !others.is_empty() && !any_open,
        };
    }
    if !participant_ids.iter().any(|id| id == me) {
        return ExpenseStanding {
            involved: false,
            open_minor: None,
            settled: false,
        };
    }
    match open_debt(pairs, expense_id, me, payer_id) {
        Some(debt) => ExpenseStanding {
            involved: true,
            open_minor: Some(-debt.remaining_minor.abs()),
            settled: false,
        },
        // A closed debt, or a share that rounded to zero and never created one.
        None => ExpenseStanding {
            involved: true,
            open_minor: Some(0),
            settled: true,
        },
    }
}

/// How far one participant has paid their share.
pub fn participant_status(pairs: &Pairs, expense: &Expense, member_id: &str) -> &'static str {
    if member_id == expense.payer_id {
        return "paid";
    }
    match open_debt(pairs, &expense.id, member_id, &expense.payer_id) {
        None => "paid",
        Some(debt) if debt.remaining_minor.abs() < debt.gross_minor.abs() => "partly_paid",
        Some(_) => "owes",
    }
}
