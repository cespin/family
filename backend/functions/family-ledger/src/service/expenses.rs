//! `POST /api/expenses` and `PUT /api/expenses/{expenseId}`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::consistent_read;
use crate::model::{AllocationItem, Expense, ExpenseEntry, Group, Kind, Payment, SplitMode, Stamp};
use crate::protocol::request_hash::request_hash;
use crate::protocol::write::{commit, kept_losing, Commit, WritePlan, WRITE_TRIES};
use crate::rules::money::{Currency, Money};
use crate::rules::replay::{pair_key, pairs_of_expense, replay_pair, slices_by_year};
use crate::rules::split::{split_equal, split_percent};
use crate::rules::validate::{
    invalid, is_uuid, no_duplicates, require_date, require_percentages, require_request_id,
    required_name, MAX_NOTE_CHARS,
};
use crate::service::access::{member_of, Signed};
use crate::service::env::Env;
use crate::service::payments::allocation_items;
use crate::service::reads::{expense_detail, read_expense, read_payment};
use crate::service::view::{active_members, payments_behind_credits, LedgerView};
use crate::store::keys;
use crate::store::table::{from_item, is_retired, retired_item, to_item, Item, Key, Table};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewExpenseRequest {
    request_id: String,
    title: String,
    kind: Kind,
    group_id: String,
    payer_id: String,
    amount_minor: i64,
    currency: Currency,
    date: String,
    transaction_date: Option<String>,
    split_mode: SplitMode,
    participant_ids: Vec<String>,
    percents: Option<BTreeMap<String, i64>>,
    other_amount: Option<Money>,
    charged_currency: Option<Currency>,
    note: Option<String>,
    usual_split: Option<BTreeMap<String, i64>>,
}

/// The same fields without the entry date, which an edit keeps, and with the version it read. An
/// absent transaction date keeps the one saved.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpenseEditRequest {
    request_id: String,
    title: String,
    kind: Kind,
    group_id: String,
    payer_id: String,
    amount_minor: i64,
    currency: Currency,
    transaction_date: Option<String>,
    split_mode: SplitMode,
    participant_ids: Vec<String>,
    percents: Option<BTreeMap<String, i64>>,
    other_amount: Option<Money>,
    charged_currency: Option<Currency>,
    note: Option<String>,
    usual_split: Option<BTreeMap<String, i64>>,
    version: u64,
}

/// What adding and editing have in common.
struct Fields {
    request_id: String,
    title: String,
    kind: Kind,
    group_id: String,
    payer_id: String,
    amount_minor: i64,
    currency: Currency,
    transaction_date: Option<String>,
    split_mode: SplitMode,
    participant_ids: Vec<String>,
    percents: Option<BTreeMap<String, i64>>,
    other_amount: Option<Money>,
    charged_currency: Option<Currency>,
    note: Option<String>,
    usual_split: Option<BTreeMap<String, i64>>,
}

fn require_amount(money_minor: i64, currency: Currency) -> Result<()> {
    if (1..=currency.expense_limit()).contains(&money_minor) {
        Ok(())
    } else {
        invalid("The amount is outside the limits for its currency.")
    }
}

/// The rules in section 7 that need nothing but the request itself.
fn check_fields(fields: &mut Fields) -> Result<()> {
    require_request_id(&fields.request_id)?;
    if let Some(date) = &fields.transaction_date {
        require_date(date)?;
    }
    fields.title = required_name(&fields.title, "title")?;
    if fields
        .note
        .as_ref()
        .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
    {
        return invalid("The note is too long.");
    }
    require_amount(fields.amount_minor, fields.currency)?;
    match &fields.other_amount {
        Some(other) => {
            require_amount(other.amount_minor, other.currency)?;
            if other.currency == fields.currency {
                return invalid("The second amount must be in a different currency.");
            }
            let charged = fields.charged_currency.unwrap_or(fields.currency);
            if charged != fields.currency && charged != other.currency {
                return invalid("The charged currency must be one of the two amounts.");
            }
            fields.charged_currency = Some(charged);
        }
        None if fields.charged_currency.is_some() => {
            return invalid("A charged currency needs a second amount.");
        }
        None => {}
    }
    if fields.participant_ids.is_empty() {
        return invalid("An expense needs at least one participant.");
    }
    no_duplicates(&fields.participant_ids, "participants")?;
    match (fields.split_mode, &fields.percents) {
        (SplitMode::Percent, Some(percents)) => {
            require_percentages(percents, &fields.participant_ids)?;
        }
        (SplitMode::Percent, None) => return invalid("A percentage split needs percentages."),
        (SplitMode::Equal, Some(_)) => return invalid("An equal split takes no percentages."),
        (SplitMode::Equal, None) => {}
    }
    if fields.usual_split.is_some() && fields.split_mode != SplitMode::Percent {
        return invalid("Only a percentage split can become the usual split.");
    }
    Ok(())
}

/// Participants in group order. Someone who left the group keeps a place after the current members.
fn ordered_participants(fields: &Fields, group: &Group, previous: Option<&Expense>) -> Vec<String> {
    let former = previous
        .iter()
        .flat_map(|expense| expense.participant_ids.iter())
        .filter(|id| !group.member_ids.contains(id));
    group
        .member_ids
        .iter()
        .chain(former)
        .filter(|id| fields.participant_ids.contains(id))
        .cloned()
        .collect()
}

/// Checks the people on an expense against its group, and works out the shares.
fn resolve_people(
    fields: &Fields,
    group: &Group,
    previous: Option<&Expense>,
    active: &HashSet<String>,
) -> Result<(Vec<String>, BTreeMap<String, i64>)> {
    // Someone who left the group may stay on its expense, but cannot follow it to another group.
    let already_on = |id: &String| {
        previous.is_some_and(|e| {
            e.group_id == fields.group_id && (e.payer_id == *id || e.participant_ids.contains(id))
        })
    };
    let people = std::iter::once(&fields.payer_id).chain(fields.participant_ids.iter());
    for id in people {
        let chosen_now = group.member_ids.contains(id) && active.contains(id);
        if !chosen_now && !already_on(id) {
            return invalid("The payer and participants must be current members of the group.");
        }
    }
    if let Some(split) = &fields.usual_split {
        require_percentages(split, &group.member_ids)?;
    }
    let participants = ordered_participants(fields, group, previous);
    let shares = match (&fields.split_mode, &fields.percents) {
        (SplitMode::Percent, Some(percents)) => {
            split_percent(fields.amount_minor, &participants, percents)
        }
        _ => split_equal(fields.amount_minor, &participants),
    };
    Ok((participants, shares))
}

fn stamp(fields: &Fields, hash: &str, rev: u64) -> Stamp {
    Stamp {
        rev,
        last_request_id: Some(fields.request_id.clone()),
        last_request_hash: Some(hash.to_string()),
    }
}

/// The group, when this expense asks to make its split the group's usual split.
fn usual_split_item(fields: &Fields, group: &Group, hash: &str, rev: u64) -> Result<Option<Item>> {
    let Some(split) = &fields.usual_split else {
        return Ok(None);
    };
    let changed = Group {
        usual_split: Some(split.clone()),
        version: group.version + 1,
        stamp: stamp(fields, hash, rev),
        ..group.clone()
    };
    Ok(Some(to_item(&keys::group(&group.id), &changed, rev)?))
}

pub(crate) fn group_entry_key(expense: &Expense) -> Key {
    Key::new(
        keys::group_expenses_pk(&expense.group_id),
        keys::entry_sort_key(expense.transaction_date(), expense.seq),
    )
}

pub(crate) fn kind_entry_key(expense: &Expense) -> Key {
    Key::new(
        keys::group_kind_pk(&expense.group_id, expense.kind),
        keys::entry_sort_key(expense.transaction_date(), expense.seq),
    )
}

async fn add_once<T: Table, E: Env>(
    table: &T,
    env: &E,
    signed: &Signed,
    fields: &Fields,
    date: &str,
    hash: &str,
) -> Result<Option<Value>> {
    let me = &signed.member_id;
    let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
    let group = view.visible_group(&fields.group_id, me)?;
    let active = active_members(table, &view.members).await?;
    let (participant_ids, shares) = resolve_people(fields, group, None, &active)?;

    let new_rev = rev + 1;
    let expense = Expense {
        id: fields.request_id.clone(),
        title: fields.title.clone(),
        kind: fields.kind,
        group_id: fields.group_id.clone(),
        payer_id: fields.payer_id.clone(),
        added_by: me.clone(),
        amount_minor: fields.amount_minor,
        currency: fields.currency,
        other_amount_minor: fields.other_amount.as_ref().map(|other| other.amount_minor),
        other_currency: fields.other_amount.as_ref().map(|other| other.currency),
        charged_currency: fields.charged_currency,
        date: date.to_string(),
        transaction_date: Some(
            fields
                .transaction_date
                .clone()
                .unwrap_or_else(|| date.to_string()),
        ),
        split_mode: fields.split_mode,
        participant_ids,
        shares,
        percents: fields.percents.clone(),
        note: fields.note.clone(),
        recorded_rates: view.current_rates(),
        recorded_at: env.now(),
        version: 1,
        seq: new_rev,
        stamp: stamp(fields, hash, new_rev),
    };

    let entry = ExpenseEntry::from(&expense);
    let mut items = vec![
        to_item(&keys::expense(&expense.id), &expense, new_rev)?,
        to_item(&group_entry_key(&expense), &entry, new_rev)?,
        to_item(&kind_entry_key(&expense), &entry, new_rev)?,
    ];

    let pairs = pairs_of_expense(&expense);
    let states: Vec<_> = pairs
        .iter()
        .map(|(low, high)| view.pair_state(low, high))
        .collect();
    let payments = payments_behind_credits(table, states.iter()).await?;
    let dates = HashMap::from([(expense.id.clone(), expense.date.clone())]);
    for mut state in states {
        let slices = state.apply_expense(&expense, &payments)?;
        items.push(to_item(
            &keys::pair(&state.low, &state.high),
            &state.to_item(),
            new_rev,
        )?);
        items.extend(
            allocation_items(table, &state.low, &state.high, slices, &dates, new_rev).await?,
        );
    }
    items.extend(usual_split_item(fields, group, hash, new_rev)?);

    let plan = WritePlan {
        items,
        unstamped: Vec::new(),
    };
    match commit(table, rev, &signed.email, plan).await? {
        Commit::Saved => Ok(Some(expense_detail(table, me, &expense.id).await?)),
        Commit::Contended => Ok(None),
    }
}

pub async fn post_expense<T: Table, E: Env>(
    table: &T,
    env: &E,
    caller: &Caller,
    raw: Value,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let hash = request_hash(&raw);
    let request: NewExpenseRequest = serde_json::from_value(raw)?;
    let date = request.date;
    let mut fields = Fields {
        request_id: request.request_id,
        title: request.title,
        kind: request.kind,
        group_id: request.group_id,
        payer_id: request.payer_id,
        amount_minor: request.amount_minor,
        currency: request.currency,
        transaction_date: request.transaction_date,
        split_mode: request.split_mode,
        participant_ids: request.participant_ids,
        percents: request.percents,
        other_amount: request.other_amount,
        charged_currency: request.charged_currency,
        note: request.note,
        usual_split: request.usual_split,
    };
    check_fields(&mut fields)?;
    require_date(&date)?;

    for _ in 0..WRITE_TRIES {
        if let Some(item) = table.get(&keys::expense(&fields.request_id)).await? {
            let saved = read_expense(&item, &fields.request_id)?;
            if saved.stamp.last_request_hash.as_deref() != Some(&hash)
                || saved.added_by != signed.member_id
            {
                return Err(ApiError::conflict(
                    "This requestId was used for something else.",
                ));
            }
            return expense_detail(table, &signed.member_id, &saved.id).await;
        }
        if let Some(body) = add_once(table, env, &signed, &fields, &date, &hash).await? {
            return Ok(body);
        }
    }
    Err(kept_losing())
}

/// An edit cannot change what a former group member owes or is owed, because they can no longer
/// see the group.
fn check_former_members(old: &Expense, new: &Expense, group: &Group) -> Result<()> {
    let refused = || invalid("This edit would change what a former group member owes.");
    let share = |expense: &Expense, id: &str| expense.shares.get(id).copied().unwrap_or(0);
    let same_debt = old.currency == new.currency && old.group_id == new.group_id;

    if !group.member_ids.contains(&old.payer_id) {
        let everyone: BTreeSet<&String> = old.shares.keys().chain(new.shares.keys()).collect();
        let unchanged = everyone.iter().all(|id| share(old, id) == share(new, id));
        if !same_debt || old.payer_id != new.payer_id || !unchanged {
            return refused();
        }
    }
    for id in old
        .participant_ids
        .iter()
        .filter(|id| !group.member_ids.contains(id))
    {
        if *id != old.payer_id
            && (!same_debt || old.payer_id != new.payer_id || share(old, id) != share(new, id))
        {
            return refused();
        }
    }
    Ok(())
}

/// The pair and allocation items an edit changes, by replaying each affected pair.
fn replayed_items(
    view: &LedgerView,
    old: &Expense,
    new: &Expense,
    expenses: &[Expense],
    payments: &[Payment],
    stored_allocations: &BTreeMap<Key, Item>,
    rev: u64,
) -> Result<Vec<Item>> {
    let dates: HashMap<String, String> = expenses
        .iter()
        .map(|e| (e.id.clone(), e.date.clone()))
        .collect();
    let mut live: BTreeSet<(String, String)> = expenses.iter().flat_map(pairs_of_expense).collect();
    live.extend(payments.iter().map(|p| pair_key(&p.from_id, &p.to_id)));

    let mut affected = pairs_of_expense(old);
    affected.extend(pairs_of_expense(new));

    let mut items = Vec::new();
    for (low, high) in affected {
        let pair_item_key = keys::pair(&low, &high);
        let known = view.pairs.get(&(low.clone(), high.clone()));
        let mut years = BTreeMap::new();
        if live.contains(&(low.clone(), high.clone())) {
            let history = replay_pair(&low, &high, expenses, payments)?;
            let item = history.state.to_item();
            if known.map(|state| state.to_item()).as_ref() != Some(&item) {
                items.push(to_item(&pair_item_key, &item, rev)?);
            }
            years = slices_by_year(&history.slices, &dates);
        } else if known.is_some() {
            items.push(retired_item(&pair_item_key, rev));
        }

        let prefix = keys::allocation_prefix(&low, &high);
        let stored: Vec<(&Key, &Item)> = stored_allocations
            .iter()
            .filter(|(key, item)| key.sk.starts_with(&prefix) && !is_retired(item))
            .collect();
        for (year, allocations) in years.iter() {
            let key = keys::allocation(&low, &high, year);
            let value = AllocationItem {
                allocations: allocations.clone(),
            };
            let same = match stored_allocations
                .get(&key)
                .filter(|item| !is_retired(item))
            {
                Some(item) => from_item::<AllocationItem>(item)? == value,
                None => false,
            };
            if !same {
                items.push(to_item(&key, &value, rev)?);
            }
        }
        for (key, _) in stored {
            if !years.contains_key(&key.sk[prefix.len()..]) {
                items.push(retired_item(key, rev));
            }
        }
    }
    Ok(items)
}

/// The list entries an edit changes. An entry in a list the expense left is retired.
fn entry_items(old: &Expense, new: &Expense, rev: u64) -> Result<Vec<Item>> {
    let entry = ExpenseEntry::from(new);
    let unchanged = ExpenseEntry::from(old) == entry;
    let mut items = Vec::new();
    for (old_key, new_key) in [
        (group_entry_key(old), group_entry_key(new)),
        (kind_entry_key(old), kind_entry_key(new)),
    ] {
        if old_key != new_key {
            items.push(retired_item(&old_key, rev));
        }
        if old_key != new_key || !unchanged {
            items.push(to_item(&new_key, &entry, rev)?);
        }
    }
    Ok(items)
}

/// A payer who did not add the expense can correct only its amounts, its transaction date and its
/// note: who is on it and how it is split stay as the member who added it chose.
fn check_payer_edit(old: &Expense, fields: &Fields) -> Result<()> {
    let same_people = old.participant_ids.iter().collect::<BTreeSet<_>>()
        == fields.participant_ids.iter().collect::<BTreeSet<_>>();
    let unchanged = old.title == fields.title
        && old.kind == fields.kind
        && old.group_id == fields.group_id
        && old.payer_id == fields.payer_id
        && old.split_mode == fields.split_mode
        && old.percents == fields.percents
        && same_people;
    if !unchanged || fields.usual_split.is_some() {
        return Err(ApiError::forbidden(
            "the payer can change only the amounts, the transaction date and the note",
        ));
    }
    Ok(())
}

struct EditContext<'a> {
    signed: &'a Signed,
    expense_id: &'a str,
    fields: &'a Fields,
    version: u64,
    hash: &'a str,
}

async fn edit_once<T: Table>(table: &T, context: &EditContext<'_>) -> Result<Option<Value>> {
    let EditContext {
        signed,
        expense_id,
        fields,
        version,
        hash,
    } = context;
    let me = &signed.member_id;
    let not_found = || ApiError::not_found("The expense was not found.");

    let (rev, (old, view, mut expenses, payments, stored_allocations)) =
        consistent_read!(table, session, {
            let item = session
                .get(&keys::expense(expense_id))
                .await?
                .ok_or_else(not_found)?;
            let old = read_expense(&item, expense_id)?;
            let view = LedgerView::load(&mut session).await?;
            view.visible_group(&old.group_id, me)
                .map_err(|_| not_found())?;

            let mut expenses = Vec::new();
            for item in session.ledger_prefix("EXPENSE#").await? {
                let id = Key::of(&item)?.sk["EXPENSE#".len()..].to_string();
                expenses.push(read_expense(&item, &id)?);
            }
            let mut payments = Vec::new();
            for item in session.ledger_prefix("PAYMENT#").await? {
                let id = Key::of(&item)?.sk["PAYMENT#".len()..].to_string();
                payments.push(read_payment(&item, &id)?);
            }
            let mut stored_allocations = BTreeMap::new();
            for item in session.ledger_prefix("ALLOC#").await? {
                stored_allocations.insert(Key::of(&item)?, item);
            }
            (old, view, expenses, payments, stored_allocations)
        });

    if old.stamp.last_request_id.as_deref() == Some(&fields.request_id) {
        if old.stamp.last_request_hash.as_deref() == Some(*hash)
            && (old.added_by == *me || old.payer_id == *me)
        {
            return Ok(Some(expense_detail(table, me, expense_id).await?));
        }
        return Err(ApiError::conflict(
            "This requestId was used for something else.",
        ));
    }
    if old.added_by != *me {
        if old.payer_id != *me {
            return Err(ApiError::forbidden(
                "only the member who added or paid an expense can edit it",
            ));
        }
        check_payer_edit(&old, fields)?;
    }
    if old.version != *version {
        return Err(ApiError::conflict("The expense changed since it was read."));
    }

    let group = view.visible_group(&fields.group_id, me)?;
    let active = active_members(table, &view.members).await?;
    let (participant_ids, shares) = resolve_people(fields, group, Some(&old), &active)?;

    let new_rev = rev + 1;
    let new = Expense {
        title: fields.title.clone(),
        kind: fields.kind,
        group_id: fields.group_id.clone(),
        payer_id: fields.payer_id.clone(),
        amount_minor: fields.amount_minor,
        currency: fields.currency,
        other_amount_minor: fields.other_amount.as_ref().map(|other| other.amount_minor),
        other_currency: fields.other_amount.as_ref().map(|other| other.currency),
        charged_currency: fields.charged_currency,
        transaction_date: Some(
            fields
                .transaction_date
                .clone()
                .unwrap_or_else(|| old.transaction_date().to_string()),
        ),
        split_mode: fields.split_mode,
        participant_ids,
        shares,
        percents: fields.percents.clone(),
        note: fields.note.clone(),
        version: old.version + 1,
        stamp: stamp(fields, hash, new_rev),
        ..old.clone()
    };
    check_former_members(&old, &new, view.visible_group(&old.group_id, me)?)?;

    for expense in expenses.iter_mut().filter(|expense| expense.id == new.id) {
        *expense = new.clone();
    }

    let mut items = vec![to_item(&keys::expense(&new.id), &new, new_rev)?];
    items.extend(entry_items(&old, &new, new_rev)?);
    items.extend(replayed_items(
        &view,
        &old,
        &new,
        &expenses,
        &payments,
        &stored_allocations,
        new_rev,
    )?);
    items.extend(usual_split_item(fields, group, hash, new_rev)?);

    let plan = WritePlan {
        items,
        unstamped: Vec::new(),
    };
    match commit(table, rev, &signed.email, plan).await? {
        Commit::Saved => Ok(Some(expense_detail(table, me, expense_id).await?)),
        Commit::Contended => Ok(None),
    }
}

pub async fn put_expense<T: Table>(
    table: &T,
    caller: &Caller,
    expense_id: &str,
    raw: Value,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let hash = request_hash(&raw);
    let request: ExpenseEditRequest = serde_json::from_value(raw)?;
    if !is_uuid(expense_id) {
        return Err(ApiError::not_found("The expense was not found."));
    }
    let version = request.version;
    let mut fields = Fields {
        request_id: request.request_id,
        title: request.title,
        kind: request.kind,
        group_id: request.group_id,
        payer_id: request.payer_id,
        amount_minor: request.amount_minor,
        currency: request.currency,
        transaction_date: request.transaction_date,
        split_mode: request.split_mode,
        participant_ids: request.participant_ids,
        percents: request.percents,
        other_amount: request.other_amount,
        charged_currency: request.charged_currency,
        note: request.note,
        usual_split: request.usual_split,
    };
    check_fields(&mut fields)?;

    let context = EditContext {
        signed: &signed,
        expense_id,
        fields: &fields,
        version,
        hash: &hash,
    };
    for _ in 0..WRITE_TRIES {
        if let Some(body) = edit_once(table, &context).await? {
            return Ok(body);
        }
    }
    Err(kept_losing())
}
