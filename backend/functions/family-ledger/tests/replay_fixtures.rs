//! A replay of the stored events must reproduce every worked-out item in the test data.

mod support;

use std::collections::HashMap;

use family_ledger::model::{Expense, Payment};
use family_ledger::rules::pair::PairState;
use family_ledger::rules::replay::{pair_key, pairs_of_expense, replay_all, slices_by_year};
use serde_json::{json, Value};
use support::fixtures::{all_data_sets, ledger_items, Items};

fn expenses(items: &Items) -> Vec<Expense> {
    ledger_items(items, "EXPENSE#", |id, value| {
        let mut expense: Expense = serde_json::from_value(value).expect("an expense");
        expense.id = id.to_string();
        expense
    })
}

fn payments(items: &Items) -> Vec<Payment> {
    ledger_items(items, "PAYMENT#", |id, value| {
        let mut payment: Payment = serde_json::from_value(value).expect("a payment");
        payment.id = id.to_string();
        payment
    })
}

fn stored(items: &Items, sk: &str) -> Option<Value> {
    let mut item = items
        .get(&("LEDGER#main".to_string(), sk.to_string()))?
        .clone();
    for key in ["PK", "SK", "rev"] {
        item.remove(key);
    }
    Some(Value::Object(item))
}

fn pair_value(state: &PairState) -> Value {
    let mut value = json!({
        "balances": state.balances(),
        "openDebts": state.open_debts,
        "credits": state.credits,
    });
    if let Some(newest) = &state.newest {
        value["newestDebt"] = json!(newest);
    }
    value
}

#[test]
fn a_replay_reproduces_every_pair_and_allocation_item() {
    for (name, items) in all_data_sets() {
        let (expenses, payments) = (expenses(&items), payments(&items));
        let dates: HashMap<String, String> = expenses
            .iter()
            .map(|e| (e.id.clone(), e.date.clone()))
            .collect();
        let replayed = replay_all(&expenses, &payments).expect("the replay runs");

        for ((low, high), history) in &replayed {
            let sk = format!("PAIR#{low}#{high}");
            let expected = stored(&items, &sk).unwrap_or_else(|| panic!("{name}: no item {sk}"));
            assert_eq!(pair_value(&history.state), expected, "{name}: {sk}");

            for (year, slices) in slices_by_year(&history.slices, &dates) {
                let sk = format!("ALLOC#{low}#{high}#{year}");
                let expected =
                    stored(&items, &sk).unwrap_or_else(|| panic!("{name}: no item {sk}"));
                assert_eq!(json!({ "allocations": slices }), expected, "{name}: {sk}");
            }
        }
    }
}

/// Adding one event to the state stored before it must give the same result as replaying it all.
#[test]
fn applying_each_event_to_stored_state_matches_a_full_replay() {
    for (name, items) in all_data_sets() {
        let (expenses, payments) = (expenses(&items), payments(&items));
        let index: HashMap<String, Payment> =
            payments.iter().map(|p| (p.id.clone(), p.clone())).collect();

        let mut seqs: Vec<u64> = expenses.iter().map(|e| e.seq).collect();
        seqs.extend(payments.iter().map(|p| p.seq));
        seqs.sort_unstable();

        for seq in seqs {
            let earlier_expenses: Vec<Expense> =
                expenses.iter().filter(|e| e.seq < seq).cloned().collect();
            let earlier_payments: Vec<Payment> =
                payments.iter().filter(|p| p.seq < seq).cloned().collect();
            let mut now_expenses = earlier_expenses.clone();
            let mut now_payments = earlier_payments.clone();
            now_expenses.extend(expenses.iter().filter(|e| e.seq == seq).cloned());
            now_payments.extend(payments.iter().filter(|p| p.seq == seq).cloned());

            let before = replay_all(&earlier_expenses, &earlier_payments).unwrap();
            let after = replay_all(&now_expenses, &now_payments).unwrap();

            let start = |low: &str, high: &str| {
                before
                    .get(&(low.to_string(), high.to_string()))
                    .map_or_else(
                        || PairState::new(low, high),
                        |history| history.state.clone(),
                    )
            };
            let check = |low: &str, high: &str, state: PairState, slices: Vec<_>| {
                let full = &after[&(low.to_string(), high.to_string())];
                let known = before
                    .get(&(low.to_string(), high.to_string()))
                    .map_or(0, |history| history.slices.len());
                assert_eq!(
                    pair_value(&state),
                    pair_value(&full.state),
                    "{name}: seq {seq}"
                );
                assert_eq!(
                    slices,
                    full.slices[known..].to_vec(),
                    "{name}: slices at seq {seq}"
                );
            };

            for expense in expenses.iter().filter(|e| e.seq == seq) {
                for (low, high) in pairs_of_expense(expense) {
                    let mut state = start(&low, &high);
                    let slices = state.apply_expense(expense, &index).unwrap();
                    check(&low, &high, state, slices);
                }
            }
            for payment in payments.iter().filter(|p| p.seq == seq) {
                let (low, high) = pair_key(&payment.from_id, &payment.to_id);
                let mut state = start(&low, &high);
                let slices = state.apply_payment(payment).unwrap();
                check(&low, &high, state, slices);
            }
        }
    }
}
