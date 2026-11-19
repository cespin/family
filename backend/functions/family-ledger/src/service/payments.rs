//! `POST /api/payments`.

use std::collections::{BTreeMap, HashMap};

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::consistent_read;
use crate::model::{AllocationItem, AllocationSlice, Method, Payment, PaymentEntry, Stamp};
use crate::protocol::read::read_head;
use crate::protocol::request_hash::request_hash;
use crate::protocol::write::{commit, kept_losing, Commit, WritePlan, WRITE_TRIES};
use crate::rules::money::{within_tolerance, Money};
use crate::rules::validate::{invalid, require_date, require_request_id, MAX_PAYMENT_MINOR};
use crate::service::access::member_of;
use crate::service::env::Env;
use crate::service::reads::{payment_json, read_payment};
use crate::service::view::LedgerView;
use crate::store::keys;
use crate::store::table::{from_item, is_retired, to_item, Item, Key, Table};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaymentRequest {
    request_id: String,
    from_id: String,
    to_id: String,
    paid: Money,
    credited: Option<Money>,
    method: Method,
    date: String,
    group_id: Option<String>,
}

fn require_amount(money: &Money) -> Result<()> {
    if (1..=MAX_PAYMENT_MINOR).contains(&money.amount_minor) {
        Ok(())
    } else {
        invalid("A payment must be a positive amount.")
    }
}

/// Adds new slices to a pair's yearly allocation items, reading what each year already holds.
pub async fn allocation_items<T: Table>(
    table: &T,
    low: &str,
    high: &str,
    slices: Vec<AllocationSlice>,
    dates: &HashMap<String, String>,
    rev: u64,
) -> Result<Vec<Item>> {
    let mut years: BTreeMap<String, Vec<AllocationSlice>> = BTreeMap::new();
    for slice in slices {
        let date = dates
            .get(&slice.expense_id)
            .ok_or_else(|| ApiError::internal("a slice covers an unknown expense"))?;
        years.entry(date[..4].to_string()).or_default().push(slice);
    }
    let mut items = Vec::new();
    for (year, slices) in years {
        let key: Key = keys::allocation(low, high, &year);
        let mut allocations = match table.get(&key).await? {
            Some(item) if !is_retired(&item) => from_item::<AllocationItem>(&item)?.allocations,
            _ => Vec::new(),
        };
        allocations.extend(slices);
        items.push(to_item(&key, &AllocationItem { allocations }, rev)?);
    }
    Ok(items)
}

fn answer(payment: &Payment, rev: u64) -> Value {
    let mut body = payment_json(&PaymentEntry::from(payment));
    body["revision"] = json!(rev);
    body
}

pub async fn post_payment<T: Table, E: Env>(
    table: &T,
    env: &E,
    caller: &Caller,
    raw: Value,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let me = &signed.member_id;
    let hash = request_hash(&raw);
    let request: PaymentRequest = serde_json::from_value(raw)?;
    require_request_id(&request.request_id)?;
    require_amount(&request.paid)?;
    if let Some(credited) = &request.credited {
        require_amount(credited)?;
    }
    require_date(&request.date)?;
    if request.from_id == request.to_id {
        return invalid("A payment needs two different members.");
    }
    if request.from_id != *me && request.to_id != *me {
        return invalid("The caller must be one of the two members of a payment.");
    }
    let other = if request.from_id == *me {
        &request.to_id
    } else {
        &request.from_id
    };
    let key = keys::payment(&request.request_id);

    for _ in 0..WRITE_TRIES {
        if let Some(item) = table.get(&key).await? {
            let saved = read_payment(&item, &request.request_id)?;
            if saved.stamp.last_request_hash.as_deref() != Some(&hash) || saved.recorded_by != *me {
                return Err(ApiError::conflict(
                    "This requestId was used for something else.",
                ));
            }
            return Ok(answer(&saved, read_head(table).await?.rev));
        }

        let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
        // A former member can still be paid, so an old debt can always be cleared.
        if !view.members.contains_key(other) {
            return Err(ApiError::not_found("The member was not found."));
        }
        if let Some(group_id) = &request.group_id {
            if !view.visible_group(group_id, me)?.member_ids.contains(other) {
                return invalid("Both members must belong to the chosen group.");
            }
        }

        let recorded = view.current_rates();
        let rates = recorded.as_ref().map(|rates| rates.exact()).transpose()?;
        let credited = match &request.credited {
            Some(credited) if within_tolerance(&request.paid, credited, rates.as_ref()) => {
                credited.clone()
            }
            _ => request.paid.clone(),
        };

        let new_rev = rev + 1;
        let payment = Payment {
            id: request.request_id.clone(),
            from_id: request.from_id.clone(),
            to_id: request.to_id.clone(),
            paid_minor: request.paid.amount_minor,
            paid_currency: request.paid.currency,
            credited_minor: credited.amount_minor,
            credited_currency: credited.currency,
            method: request.method,
            date: request.date.clone(),
            group_id: request.group_id.clone(),
            recorded_rates: recorded,
            recorded_by: me.clone(),
            recorded_at: env.now(),
            seq: new_rev,
            stamp: Stamp {
                rev: new_rev,
                last_request_id: Some(request.request_id.clone()),
                last_request_hash: Some(hash.clone()),
            },
        };

        let mut state = view.pair_state(&payment.from_id, &payment.to_id);
        let dates: HashMap<String, String> = state
            .open_debts
            .iter()
            .map(|d| (d.expense_id.clone(), d.date.clone()))
            .collect();
        let slices = state.apply_payment(&payment)?;

        let (low, high) = (state.low.clone(), state.high.clone());
        let entry_key = Key::new(
            keys::pair_payments_pk(&low, &high),
            keys::entry_sort_key(&payment.date, payment.seq),
        );
        let mut items = vec![
            to_item(&key, &payment, new_rev)?,
            to_item(&entry_key, &PaymentEntry::from(&payment), new_rev)?,
            to_item(&keys::pair(&low, &high), &state.to_item(), new_rev)?,
        ];
        items.extend(allocation_items(table, &low, &high, slices, &dates, new_rev).await?);

        let plan = WritePlan {
            items,
            unstamped: Vec::new(),
        };
        if commit(table, rev, &signed.email, plan).await? == Commit::Saved {
            return Ok(answer(&payment, new_rev));
        }
    }
    Err(kept_losing())
}
