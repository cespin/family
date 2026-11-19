//! How expenses and payments change what two members owe each other: sections 6 and 12 of the
//! requirements. A full replay and a single new event run through this same code, so the two can
//! never disagree.
//!
//! Amounts are signed from the point of view of the lower member: positive means the higher member
//! owes.

use std::collections::HashMap;

use family_core::{ApiError, Result};

use crate::model::{AllocationSlice, Balance, Credit, Debt, Expense, Newest, PairItem, Payment};
use crate::rules::exact::{self, Exact};
use crate::rules::money::{convert, Currency, Money, Rates};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairState {
    pub low: String,
    pub high: String,
    pub open_debts: Vec<Debt>,
    pub credits: Vec<Credit>,
    pub newest: Option<Newest>,
}

fn smallest(values: [&Exact; 3]) -> Exact {
    let [first, second, third] = values;
    first.min(second).min(third).clone()
}

fn magnitude(value: &Exact) -> Exact {
    if *value < exact::zero() {
        -value.clone()
    } else {
        value.clone()
    }
}

fn is_positive(value: &Exact) -> bool {
    *value > exact::zero()
}

fn rates_of(recorded: Option<&crate::rules::money::RecordedRates>) -> Result<Option<Rates>> {
    recorded.map(|rates| rates.exact()).transpose()
}

/// A payment's share of what was really paid. Rounding the running total means the slices of a
/// payment add up to what was paid.
fn paid_share(payment: &Payment, value: &Exact) -> i64 {
    exact::round(&(exact::whole(payment.paid_minor) * value / exact::whole(payment.credited_minor)))
}

fn slice(
    payment: &Payment,
    expense_id: &str,
    before: &Exact,
    applied: &Exact,
    covered_minor: i64,
) -> AllocationSlice {
    let after = before + applied;
    AllocationSlice {
        expense_id: expense_id.to_string(),
        payment_id: payment.id.clone(),
        from_id: payment.from_id.clone(),
        to_id: payment.to_id.clone(),
        paid_minor: paid_share(payment, &after) - paid_share(payment, before),
        paid_currency: payment.paid_currency,
        covered_minor,
        method: payment.method,
        date: payment.date.clone(),
    }
}

impl PairState {
    pub fn new(low: &str, high: &str) -> Self {
        Self {
            low: low.to_string(),
            high: high.to_string(),
            open_debts: Vec::new(),
            credits: Vec::new(),
            newest: None,
        }
    }

    fn group_net(
        &self,
        group_id: &str,
        currency: Currency,
        rates: Option<&Rates>,
    ) -> (Exact, bool) {
        let mut value = exact::zero();
        let mut complete = true;
        for debt in self
            .open_debts
            .iter()
            .filter(|d| !d.closed && d.group_id == group_id)
        {
            match convert(
                &exact::whole(debt.remaining_minor),
                debt.currency,
                currency,
                rates,
            ) {
                Some(converted) => value += converted,
                None => complete = false,
            }
        }
        (value, complete)
    }

    fn close_if_even(&mut self, group_id: &str, currency: Currency, rates: Option<&Rates>) {
        let (value, complete) = self.group_net(group_id, currency, rates);
        if complete && exact::round(&value) == 0 {
            for debt in self
                .open_debts
                .iter_mut()
                .filter(|d| d.group_id == group_id)
            {
                debt.closed = true;
            }
        }
    }

    /// How much of a group can still be paid, in `currency`, by the side owing `direction`.
    fn room(
        &self,
        group_id: &str,
        direction: i64,
        currency: Currency,
        rates: Option<&Rates>,
    ) -> Exact {
        let signed = self.group_net(group_id, currency, rates).0 * exact::whole(direction);
        if is_positive(&signed) {
            signed
        } else {
            exact::zero()
        }
    }

    /// Applies `taken` to one debt and returns the whole amount it covered, if any.
    fn cover(
        &mut self,
        index: usize,
        taken: &Exact,
        owed: &Exact,
        currency: Currency,
        rates: Option<&Rates>,
    ) -> Option<i64> {
        let debt = &mut self.open_debts[index];
        let size = debt.remaining_minor.abs();
        let covered = if taken >= owed {
            size
        } else {
            let converted = convert(taken, currency, debt.currency, rates)?;
            size.min(exact::round(&converted))
        };
        if covered == 0 {
            return None;
        }
        debt.remaining_minor -= debt.remaining_minor.signum() * covered;
        if debt.remaining_minor == 0 {
            debt.closed = true;
        }
        Some(covered)
    }

    fn settle(&mut self) {
        self.open_debts.retain(|debt| !debt.closed);
        self.credits.retain(|credit| credit.amount_minor != 0);
    }

    /// Records an expense. `payments` must hold the payment behind every credit in this pair.
    pub fn apply_expense(
        &mut self,
        expense: &Expense,
        payments: &HashMap<String, Payment>,
    ) -> Result<Vec<AllocationSlice>> {
        let share_of = |id: &str| expense.shares.get(id).copied().unwrap_or(0);
        let gross = if expense.payer_id == self.low {
            share_of(&self.high)
        } else if expense.payer_id == self.high {
            -share_of(&self.low)
        } else {
            0
        };
        if gross == 0 {
            return Ok(Vec::new());
        }

        let rates = rates_of(expense.recorded_rates.as_ref())?;
        let rates = rates.as_ref();
        let currency = expense.currency;
        let group_id = expense.group_id.as_str();

        self.open_debts.push(Debt {
            expense_id: expense.id.clone(),
            group_id: group_id.to_string(),
            date: expense.date.clone(),
            seq: expense.seq,
            currency,
            gross_minor: gross,
            remaining_minor: gross,
            closed: false,
        });
        let index = self.open_debts.len() - 1;
        let is_newer = self.newest.as_ref().is_none_or(|newest| {
            expense.date > newest.date || (expense.date == newest.date && expense.seq > newest.seq)
        });
        if is_newer {
            self.newest = Some(Newest {
                date: expense.date.clone(),
                seq: expense.seq,
                group_id: group_id.to_string(),
            });
        }

        // Credit held by the person who now owes this debt pays it straight away.
        let holder_sign = -gross.signum();
        let mut usable: Vec<usize> = (0..self.credits.len())
            .filter(|&i| self.credits[i].amount_minor.signum() == holder_sign)
            .collect();
        usable.sort_by_key(|&i| {
            let credit = &self.credits[i];
            (credit.group_id.as_deref() != Some(group_id), credit.seq)
        });

        let mut slices = Vec::new();
        for credit_index in usable {
            let credit = self.credits[credit_index].clone();
            let size = credit.amount_minor.abs();
            let available = convert(&exact::whole(size), credit.currency, currency, rates);
            let remaining = self.open_debts[index].remaining_minor;
            let Some(available) = available.filter(|_| remaining != 0) else {
                continue;
            };
            let owed = exact::whole(remaining.abs());
            let limit = self.room(group_id, gross.signum(), currency, rates);
            let taken = smallest([&available, &owed, &limit]);
            if !is_positive(&taken) {
                continue;
            }
            let used = if taken >= available {
                size
            } else {
                let converted = convert(&taken, currency, credit.currency, rates)
                    .ok_or_else(|| ApiError::internal("credit could not be converted back"))?;
                exact::round(&converted)
            };
            if let Some(covered) = self.cover(index, &taken, &owed, currency, rates) {
                let payment = payments.get(&credit.payment_id).ok_or_else(|| {
                    ApiError::internal(format!("payment {} is missing", credit.payment_id))
                })?;
                let applied = exact::whole(used);
                slices.push(slice(
                    payment,
                    &expense.id,
                    &credit.applied_total,
                    &applied,
                    covered,
                ));
                let stored = &mut self.credits[credit_index];
                stored.applied_total += applied;
                stored.amount_minor -= stored.amount_minor.signum() * used;
            }
        }

        self.close_if_even(group_id, currency, rates);
        self.settle();
        Ok(slices)
    }

    /// Records a payment between the two members.
    pub fn apply_payment(&mut self, payment: &Payment) -> Result<Vec<AllocationSlice>> {
        let rates = rates_of(payment.recorded_rates.as_ref())?;
        let rates = rates.as_ref();
        let credited = Money {
            amount_minor: payment.credited_minor,
            currency: payment.credited_currency,
        };
        let currency = credited.currency;
        // The payer owes the debts whose sign this is.
        let direction: i64 = if payment.from_id == self.low { -1 } else { 1 };
        let chosen = payment.group_id.as_deref();

        let mut owing: Vec<usize> = (0..self.open_debts.len())
            .filter(|&i| self.open_debts[i].remaining_minor.signum() == direction)
            .collect();
        owing.sort_by(|&a, &b| {
            let (a, b) = (&self.open_debts[a], &self.open_debts[b]);
            a.date.cmp(&b.date).then(a.seq.cmp(&b.seq))
        });
        // A stable sort keeps oldest first inside the chosen group and inside the rest.
        owing.sort_by_key(|&i| {
            chosen.is_some() && Some(self.open_debts[i].group_id.as_str()) != chosen
        });

        let mut left = exact::whole(credited.amount_minor);
        let mut allocated = exact::zero();
        let mut slices = Vec::new();

        for index in owing {
            let debt = &self.open_debts[index];
            let size = exact::whole(debt.remaining_minor.abs());
            let owed = convert(&size, debt.currency, currency, rates);
            let Some(owed) = owed.filter(|_| !debt.closed && is_positive(&left)) else {
                continue;
            };
            let debt_group = debt.group_id.clone();
            let expense_id = debt.expense_id.clone();
            let limit = self.room(&debt_group, direction, currency, rates);
            let taken = smallest([&left, &owed, &limit]);
            if !is_positive(&taken) {
                continue;
            }
            if let Some(covered) = self.cover(index, &taken, &owed, currency, rates) {
                slices.push(slice(payment, &expense_id, &allocated, &taken, covered));
                left -= &taken;
                allocated += &taken;
                self.close_if_even(&debt_group, currency, rates);
            }
        }

        // What remains first repays credit the other person holds.
        let mut owed_back: Vec<usize> = (0..self.credits.len())
            .filter(|&i| self.credits[i].amount_minor.signum() == direction)
            .collect();
        owed_back.sort_by_key(|&i| self.credits[i].seq);
        for credit_index in owed_back {
            let credit = &self.credits[credit_index];
            let size = credit.amount_minor.abs();
            let available = convert(&exact::whole(size), credit.currency, currency, rates);
            let Some(available) = available.filter(|_| is_positive(&left)) else {
                continue;
            };
            let taken = (&left).min(&available).clone();
            let used = if taken >= available {
                size
            } else {
                let converted = convert(&taken, currency, credit.currency, rates)
                    .ok_or_else(|| ApiError::internal("credit could not be converted back"))?;
                exact::round(&converted)
            };
            let stored = &mut self.credits[credit_index];
            stored.amount_minor -= stored.amount_minor.signum() * used;
            left -= taken;
        }

        // Anything still left becomes credit in the payer's favour.
        let rest = exact::round(&magnitude(&left));
        if rest > 0 {
            self.credits.push(Credit {
                payment_id: payment.id.clone(),
                seq: payment.seq,
                amount_minor: -direction * rest,
                currency,
                group_id: payment
                    .group_id
                    .clone()
                    .or_else(|| self.newest.as_ref().map(|newest| newest.group_id.clone())),
                applied_total: allocated,
            });
        }
        self.settle();
        Ok(slices)
    }

    pub fn from_item(low: &str, high: &str, item: PairItem) -> Self {
        Self {
            low: low.to_string(),
            high: high.to_string(),
            open_debts: item.open_debts,
            credits: item.credits,
            newest: item.newest_debt,
        }
    }

    pub fn to_item(&self) -> PairItem {
        PairItem {
            balances: self.balances(),
            open_debts: self.open_debts.clone(),
            credits: self.credits.clone(),
            newest_debt: self.newest.clone(),
        }
    }

    /// What is open per group and currency, from the lower member's point of view.
    pub fn balances(&self) -> Vec<Balance> {
        let mut totals: Vec<Balance> = Vec::new();
        let mut add = |group_id: Option<&str>, currency: Currency, amount_minor: i64| {
            let found = totals
                .iter_mut()
                .find(|entry| entry.group_id.as_deref() == group_id && entry.currency == currency);
            match found {
                Some(entry) => entry.amount_minor += amount_minor,
                None => totals.push(Balance {
                    group_id: group_id.map(str::to_string),
                    currency,
                    amount_minor,
                }),
            }
        };
        for debt in &self.open_debts {
            add(Some(&debt.group_id), debt.currency, debt.remaining_minor);
        }
        for credit in &self.credits {
            add(
                credit.group_id.as_deref(),
                credit.currency,
                credit.amount_minor,
            );
        }
        totals.retain(|entry| entry.amount_minor != 0);
        totals
    }
}
