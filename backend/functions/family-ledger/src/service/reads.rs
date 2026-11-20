//! The read routes.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::consistent_read;
use crate::model::{
    AllocationItem, AllocationSlice, Expense, ExpenseEntry, Group, Kind, Payment, PaymentEntry,
    RateEntry, SplitMode,
};
use crate::protocol::read::ReadSession;
use crate::rules::exact;
use crate::rules::replay::pairs_of_expense;
use crate::rules::standing::{
    expense_standing, participant_status, standings_for, ExpenseStanding, StandingEntry,
};
use crate::rules::validate::is_uuid;
use crate::service::access::{account_of, member_of, read_member};
use crate::service::view::{active_members, LedgerView};
use crate::store::keys;
use crate::store::table::{from_item, is_retired, Item, Key, PageQuery, Table};

const DEFAULT_PAGE: usize = 50;
const LARGEST_PAGE: usize = 100;

pub fn group_json(group: &Group) -> Value {
    json!({
        "id": group.id,
        "name": group.name,
        "createdBy": group.created_by,
        "memberIds": group.member_ids,
        "usualSplit": group.usual_split,
        "version": group.version,
    })
}

pub fn rate_json(rate: &RateEntry) -> Value {
    json!({
        "id": rate.id,
        "usdCad": rate.usd_cad,
        "cadClp": rate.cad_clp,
        "date": rate.date,
        "enteredBy": rate.entered_by,
    })
}

pub fn payment_json(entry: &PaymentEntry) -> Value {
    json!({
        "id": entry.payment_id,
        "fromId": entry.from_id,
        "toId": entry.to_id,
        "paid": { "amountMinor": entry.paid_minor, "currency": entry.paid_currency },
        "credited": { "amountMinor": entry.credited_minor, "currency": entry.credited_currency },
        "method": entry.method,
        "date": entry.date,
        "transactionDate": entry.transaction_date(),
        "groupId": entry.group_id,
        "version": entry.version,
    })
}

fn standing_json(standing: &ExpenseStanding) -> Value {
    json!({
        "involved": standing.involved,
        "openMinor": standing.open_minor,
        "settled": standing.settled,
    })
}

/// `GET /api/me`. Someone who has not finished signing up gets nulls rather than a refusal.
pub async fn me<T: Table>(table: &T, caller: &Caller) -> Result<Value> {
    let account = account_of(table, caller).await?;
    let member = match &account.member_id {
        Some(id) => read_member(table, id).await?,
        None => None,
    };
    Ok(json!({
        "sub": caller.sub,
        "email": caller.email,
        "name": caller.name,
        "memberId": account.member_id,
        "displayName": member.as_ref().map(|m| &m.display_name),
        "homeCurrency": member.as_ref().map(|m| m.home_currency),
    }))
}

fn amounts_json(amounts: &[(crate::rules::money::Currency, i64)]) -> Vec<Value> {
    amounts
        .iter()
        .filter(|(_, minor)| *minor != 0)
        .map(|(currency, minor)| json!({ "amountMinor": minor, "currency": currency }))
        .collect()
}

fn add_amount(amounts: &mut Vec<(crate::rules::money::Currency, i64)>, entry: &StandingEntry) {
    match amounts
        .iter_mut()
        .find(|(currency, _)| *currency == entry.currency)
    {
        Some((_, minor)) => *minor += entry.amount_minor,
        None => amounts.push((entry.currency, entry.amount_minor)),
    }
}

fn standing_row(member_id: &str, entries: &[StandingEntry]) -> Value {
    let mut overall = Vec::new();
    let mut groups: Vec<(Option<String>, Vec<_>)> = Vec::new();
    for entry in entries {
        add_amount(&mut overall, entry);
        let position = groups.iter().position(|(id, _)| *id == entry.group_id);
        let index = position.unwrap_or_else(|| {
            groups.push((entry.group_id.clone(), Vec::new()));
            groups.len() - 1
        });
        add_amount(&mut groups[index].1, entry);
    }
    let groups: Vec<Value> = groups
        .iter()
        .map(|(id, amounts)| json!({ "groupId": id, "amounts": amounts_json(amounts) }))
        .collect();
    json!({ "memberId": member_id, "overall": amounts_json(&overall), "groups": groups })
}

/// `GET /api/ledger`.
pub async fn ledger<T: Table>(table: &T, caller: &Caller) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let me = &signed.member_id;
    let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
    let active = active_members(table, &view.members).await?;

    let members: Vec<Value> = view
        .members
        .values()
        .map(|member| {
            json!({
                "id": member.id,
                "displayName": member.display_name,
                "homeCurrency": member.home_currency,
                "tone": member.tone,
                "active": active.contains(&member.id),
            })
        })
        .collect();
    let groups: Vec<Value> = view
        .groups
        .values()
        .filter(|group| group.member_ids.contains(me))
        .map(group_json)
        .collect();
    let rates: Vec<Value> = view.rates.iter().rev().map(rate_json).collect();
    let standings: Vec<Value> = standings_for(&view.pairs, me)
        .iter()
        .map(|(member_id, entries)| standing_row(member_id, entries))
        .collect();

    Ok(json!({
        "revision": rev,
        "me": me,
        "members": members,
        "groups": groups,
        "exchangeRates": rates,
        "standings": standings,
    }))
}

/// Where a page stopped, tied to the filters it was read with.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    position: String,
    filters: String,
}

fn encode_cursor(position: &str, filters: &str) -> String {
    let cursor = Cursor {
        position: position.to_string(),
        filters: filters.to_string(),
    };
    let text = serde_json::to_string(&cursor).unwrap_or_default();
    text.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn is_position(text: &str) -> bool {
    match text.split_once('#') {
        Some((date, seq)) => {
            crate::rules::validate::is_date(date)
                && seq.len() >= 8
                && seq.bytes().all(|byte| byte.is_ascii_digit())
        }
        None => false,
    }
}

/// The position to continue from. A cursor is valid only with the filters that produced it.
fn decode_cursor(text: Option<&str>, filters: &str) -> Result<Option<String>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let refused = || ApiError::validation("The cursor is not valid.");
    if text.len() % 2 != 0 || !text.is_ascii() {
        return Err(refused());
    }
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16))
        .collect::<std::result::Result<Vec<u8>, _>>()
        .map_err(|_| refused())?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if cursor.filters != filters || !is_position(&cursor.position) {
        return Err(refused());
    }
    Ok(Some(cursor.position))
}

fn parse_limit(text: Option<&str>) -> Result<usize> {
    let Some(text) = text else {
        return Ok(DEFAULT_PAGE);
    };
    match text.parse::<usize>() {
        Ok(limit) if (1..=LARGEST_PAGE).contains(&limit) => Ok(limit),
        _ => Err(ApiError::validation("The limit must be between 1 and 100.")),
    }
}

/// Reads list entries, newest first, skipping retired ones until enough are found.
async fn live_entries<T: Table>(
    session: &mut ReadSession<'_, T>,
    pk: String,
    before: Option<&str>,
    wanted: usize,
) -> Result<Vec<Item>> {
    let mut query = PageQuery {
        pk,
        before: before.map(str::to_string),
        descending: true,
        limit: Some(wanted),
        ..PageQuery::default()
    };
    let mut live = Vec::new();
    loop {
        let page = session.query_page(&query).await?;
        live.extend(page.items.into_iter().filter(|item| !is_retired(item)));
        if live.len() >= wanted {
            live.truncate(wanted);
            return Ok(live);
        }
        match page.next {
            Some(next) => query.start_after = Some(next),
            None => return Ok(live),
        }
    }
}

fn sort_key(item: &Item) -> &str {
    item.get("SK").and_then(Value::as_str).unwrap_or_default()
}

/// Merges lists newest first, and splits off one page and where the next one starts.
fn one_page(mut entries: Vec<Item>, limit: usize) -> (Vec<Item>, Option<String>) {
    entries.sort_by(|a, b| sort_key(b).cmp(sort_key(a)));
    let more = entries.len() > limit;
    entries.truncate(limit);
    let next = more
        .then(|| entries.last().map(|item| sort_key(item).to_string()))
        .flatten();
    (entries, next)
}

#[derive(Debug, Default)]
pub struct ExpenseFilters {
    pub group_id: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<String>,
    pub cursor: Option<String>,
}

/// `GET /api/expenses`.
pub async fn list_expenses<T: Table>(
    table: &T,
    caller: &Caller,
    filters: &ExpenseFilters,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let me = &signed.member_id;
    let limit = parse_limit(filters.limit.as_deref())?;
    let kind: Option<Kind> = filters
        .kind
        .as_deref()
        .map(|kind| serde_json::from_value(json!(kind)))
        .transpose()
        .map_err(|_| ApiError::validation("The kind is not valid."))?;
    let fingerprint = format!(
        "{}|{}",
        filters.group_id.as_deref().unwrap_or_default(),
        filters.kind.as_deref().unwrap_or_default()
    );
    let before = decode_cursor(filters.cursor.as_deref(), &fingerprint)?;

    let (rev, (view, entries)) = consistent_read!(table, session, {
        let view = LedgerView::load(&mut session).await?;
        let group_ids: Vec<String> = match &filters.group_id {
            Some(id) => vec![view.visible_group(id, me)?.id.clone()],
            None => view
                .groups
                .values()
                .filter(|group| group.member_ids.contains(me))
                .map(|group| group.id.clone())
                .collect(),
        };
        let mut entries = Vec::new();
        for group_id in group_ids {
            let pk = match kind {
                Some(kind) => keys::group_kind_pk(&group_id, kind),
                None => keys::group_expenses_pk(&group_id),
            };
            entries.extend(live_entries(&mut session, pk, before.as_deref(), limit + 1).await?);
        }
        (view, entries)
    });

    let (page, next) = one_page(entries, limit);
    let expenses = page
        .iter()
        .map(|item| {
            let entry: ExpenseEntry = from_item(item)?;
            let standing = expense_standing(
                &view.pairs,
                &entry.expense_id,
                &entry.payer_id,
                &entry.participant_ids,
                me,
            );
            let mut row = json!({
                "id": entry.expense_id,
                "title": entry.title,
                "kind": entry.kind,
                "groupId": entry.group_id,
                "payerId": entry.payer_id,
                "addedBy": entry.added_by,
                "amountMinor": entry.amount_minor,
                "currency": entry.currency,
                "date": entry.date,
                "transactionDate": entry.transaction_date(),
                "participantIds": entry.participant_ids,
                "standing": standing_json(&standing),
            });
            // Entries saved before they carried shares list without a split: absent, not zero.
            if let (Some(split_mode), Some(shares)) = (entry.split_mode, &entry.shares) {
                let participants: Vec<Value> = entry
                    .participant_ids
                    .iter()
                    .map(|id| {
                        let share = shares.get(id).copied().unwrap_or(0);
                        share_json(id, share, split_mode, entry.percents.as_ref())
                    })
                    .collect();
                row["splitMode"] = json!(split_mode);
                row["participants"] = json!(participants);
            }
            Ok(row)
        })
        .collect::<Result<Vec<Value>>>()?;

    Ok(json!({
        "revision": rev,
        "expenses": expenses,
        "nextCursor": next.map(|position| encode_cursor(&position, &fingerprint)),
    }))
}

#[derive(Debug, Default)]
pub struct PaymentFilters {
    pub member_id: Option<String>,
    pub limit: Option<String>,
    pub cursor: Option<String>,
}

/// `GET /api/payments`: the caller's own payments, optionally with one person.
pub async fn list_payments<T: Table>(
    table: &T,
    caller: &Caller,
    filters: &PaymentFilters,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let me = &signed.member_id;
    let limit = parse_limit(filters.limit.as_deref())?;
    let fingerprint = filters.member_id.clone().unwrap_or_default();
    let before = decode_cursor(filters.cursor.as_deref(), &fingerprint)?;

    let (rev, entries) = consistent_read!(table, session, {
        let view = LedgerView::load(&mut session).await?;
        let others: Vec<String> = match &filters.member_id {
            Some(id) if view.members.contains_key(id) => vec![id.clone()],
            Some(_) => return Err(ApiError::not_found("The member was not found.")),
            None => view
                .pairs
                .values()
                .filter(|pair| pair.low == *me || pair.high == *me)
                .map(|pair| {
                    if pair.low == *me {
                        pair.high.clone()
                    } else {
                        pair.low.clone()
                    }
                })
                .collect(),
        };
        let mut entries = Vec::new();
        for other in others {
            let pk = keys::pair_payments_pk(me, &other);
            entries.extend(live_entries(&mut session, pk, before.as_deref(), limit + 1).await?);
        }
        entries
    });

    let (page, next) = one_page(entries, limit);
    let payments = page
        .iter()
        .map(|item| Ok(payment_json(&from_item::<PaymentEntry>(item)?)))
        .collect::<Result<Vec<Value>>>()?;
    Ok(json!({
        "revision": rev,
        "payments": payments,
        "nextCursor": next.map(|position| encode_cursor(&position, &fingerprint)),
    }))
}

pub fn read_expense(item: &Item, id: &str) -> Result<Expense> {
    let mut expense: Expense = from_item(item)?;
    expense.id = id.to_string();
    Ok(expense)
}

pub fn read_payment(item: &Item, id: &str) -> Result<Payment> {
    let mut payment: Payment = from_item(item)?;
    payment.id = id.to_string();
    Ok(payment)
}

/// What payments covered on one expense, including credit applied to it.
async fn slices_of<T: Table>(
    session: &mut ReadSession<'_, T>,
    expense: &Expense,
) -> Result<Vec<AllocationSlice>> {
    let year = &expense.date[..4];
    let wanted: Vec<Key> = pairs_of_expense(expense)
        .iter()
        .map(|(low, high)| keys::allocation(low, high, year))
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let mut items: BTreeMap<Key, Item> = BTreeMap::new();
    for item in session.batch_get(&wanted).await? {
        items.insert(Key::of(&item)?, item);
    }
    let mut slices = Vec::new();
    for item in items.values().filter(|item| !is_retired(item)) {
        let allocations: AllocationItem = from_item(item)?;
        slices.extend(
            allocations
                .allocations
                .into_iter()
                .filter(|s| s.expense_id == expense.id),
        );
    }
    Ok(slices)
}

/// The day each payment behind these slices was given. A slice keeps the day it was entered, so
/// correcting a payment's day never rewrites the allocations.
async fn transaction_dates<T: Table>(
    session: &mut ReadSession<'_, T>,
    slices: &[AllocationSlice],
) -> Result<HashMap<String, String>> {
    let wanted: BTreeSet<&str> = slices.iter().map(|s| s.payment_id.as_str()).collect();
    let keys: Vec<Key> = wanted.into_iter().map(keys::payment).collect();
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let mut dates = HashMap::new();
    for item in session.batch_get(&keys).await? {
        let key = Key::of(&item)?;
        let payment = read_payment(&item, &key.sk["PAYMENT#".len()..])?;
        dates.insert(payment.id.clone(), payment.transaction_date().to_string());
    }
    Ok(dates)
}

fn other_share(expense: &Expense, share: i64) -> Option<i64> {
    let other = expense.other_amount_minor?;
    let value = exact::whole(share) * exact::whole(other) / exact::whole(expense.amount_minor);
    Some(exact::round(&value))
}

/// One participant's part of an expense, as both the list and the detail return it: the share,
/// and the percentage when the split is by percent.
fn share_json(
    id: &str,
    share: i64,
    split_mode: SplitMode,
    percents: Option<&BTreeMap<String, i64>>,
) -> Value {
    let mut row = json!({ "memberId": id, "shareMinor": share });
    if split_mode == SplitMode::Percent {
        row["percent"] = json!(percents.and_then(|p| p.get(id)));
    }
    row
}

fn detail_json(
    rev: u64,
    expense: &Expense,
    view: &LedgerView,
    slices: &[AllocationSlice],
    paid_on: &HashMap<String, String>,
    me: &str,
) -> Value {
    let participants: Vec<Value> = expense
        .participant_ids
        .iter()
        .map(|id| {
            let share = expense.shares.get(id).copied().unwrap_or(0);
            let mut row = share_json(id, share, expense.split_mode, expense.percents.as_ref());
            row["status"] = json!(participant_status(&view.pairs, expense, id));
            if let Some(other) = other_share(expense, share) {
                row["otherShareMinor"] = json!(other);
            }
            row
        })
        .collect();
    let applied: Vec<Value> = slices
        .iter()
        .map(|slice| {
            json!({
                "paymentId": slice.payment_id,
                "fromId": slice.from_id,
                "toId": slice.to_id,
                "paidMinor": slice.paid_minor,
                "paidCurrency": slice.paid_currency,
                "coveredMinor": slice.covered_minor,
                "method": slice.method,
                "date": slice.date,
                "transactionDate": paid_on.get(&slice.payment_id).unwrap_or(&slice.date),
            })
        })
        .collect();
    let standing = expense_standing(
        &view.pairs,
        &expense.id,
        &expense.payer_id,
        &expense.participant_ids,
        me,
    );
    let mut body = json!({
        "revision": rev,
        "id": expense.id,
        "title": expense.title,
        "kind": expense.kind,
        "groupId": expense.group_id,
        "payerId": expense.payer_id,
        "addedBy": expense.added_by,
        "amountMinor": expense.amount_minor,
        "currency": expense.currency,
        "date": expense.date,
        "transactionDate": expense.transaction_date(),
        "splitMode": expense.split_mode,
        "note": expense.note,
        "ratesId": view.rates_on(&expense.date).map(|rate| &rate.id),
        "version": expense.version,
        "participants": participants,
        "standing": standing_json(&standing),
        "appliedPayments": applied,
    });
    if let (Some(minor), Some(currency)) = (expense.other_amount_minor, expense.other_currency) {
        body["otherAmount"] = json!({ "amountMinor": minor, "currency": currency });
        body["chargedCurrency"] = json!(expense.charged_currency);
    }
    body
}

/// One expense in full, as `me` sees it.
pub async fn expense_detail<T: Table>(table: &T, me: &str, expense_id: &str) -> Result<Value> {
    let not_found = || ApiError::not_found("The expense was not found.");
    if !is_uuid(expense_id) {
        return Err(not_found());
    }
    let (rev, (expense, view, slices, paid_on)) = consistent_read!(table, session, {
        let item = session
            .get(&keys::expense(expense_id))
            .await?
            .ok_or_else(not_found)?;
        let expense = read_expense(&item, expense_id)?;
        let view = LedgerView::load(&mut session).await?;
        view.visible_group(&expense.group_id, me)
            .map_err(|_| not_found())?;
        let slices = slices_of(&mut session, &expense).await?;
        let paid_on = transaction_dates(&mut session, &slices).await?;
        (expense, view, slices, paid_on)
    });
    Ok(detail_json(rev, &expense, &view, &slices, &paid_on, me))
}

/// `GET /api/expenses/{expenseId}`.
pub async fn get_expense<T: Table>(table: &T, caller: &Caller, expense_id: &str) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    expense_detail(table, &signed.member_id, expense_id).await
}
