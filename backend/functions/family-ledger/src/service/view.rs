//! The balances, groups, members and rates, read together.

use std::collections::{BTreeMap, HashMap, HashSet};

use family_core::{ApiError, Result};

use crate::model::{Group, Member, PairItem, Payment, RateEntry};
use crate::protocol::read::ReadSession;
use crate::rules::money::RecordedRates;
use crate::rules::pair::PairState;
use crate::rules::replay::pair_key;
use crate::rules::standing::Pairs;
use crate::store::keys;
use crate::store::table::{from_item, is_retired, Item, Key, Table};

#[derive(Debug, Clone, Default)]
pub struct LedgerView {
    pub members: BTreeMap<String, Member>,
    pub groups: BTreeMap<String, Group>,
    pub pairs: Pairs,
    /// In the order they were entered, so the last one is the current one.
    pub rates: Vec<RateEntry>,
}

fn id_after<'a>(item: &'a Item, prefix: &str) -> Result<&'a str> {
    item.get("SK")
        .and_then(|sk| sk.as_str())
        .and_then(|sk| sk.strip_prefix(prefix))
        .ok_or_else(|| ApiError::internal("an item has an unexpected sort key"))
}

impl LedgerView {
    pub async fn load<T: Table>(session: &mut ReadSession<'_, T>) -> Result<Self> {
        let mut view = Self::default();
        for item in session.ledger_prefix("PROFILE#").await? {
            let mut member: Member = from_item(&item)?;
            member.id = id_after(&item, "PROFILE#")?.to_string();
            view.members.insert(member.id.clone(), member);
        }
        for item in session.ledger_prefix("GROUP#").await? {
            let mut group: Group = from_item(&item)?;
            group.id = id_after(&item, "GROUP#")?.to_string();
            view.groups.insert(group.id.clone(), group);
        }
        for item in session.ledger_prefix("PAIR#").await? {
            if is_retired(&item) {
                continue;
            }
            let (low, high) = id_after(&item, "PAIR#")?
                .split_once('#')
                .ok_or_else(|| ApiError::internal("a pair item has an unexpected sort key"))?;
            let state = PairState::from_item(low, high, from_item::<PairItem>(&item)?);
            view.pairs
                .insert((low.to_string(), high.to_string()), state);
        }
        for item in session.ledger_prefix("RATE#").await? {
            let mut rate: RateEntry = from_item(&item)?;
            rate.id = id_after(&item, "RATE#")?.to_string();
            view.rates.push(rate);
        }
        // Rate identifiers are random, so only `seq` knows the order they were entered in.
        view.rates.sort_by_key(|rate| rate.seq);
        Ok(view)
    }

    pub fn current_rates(&self) -> Option<RecordedRates> {
        self.rates.last().map(RateEntry::recorded)
    }

    /// The entry in force on a date: the latest one entered on or before it.
    pub fn rates_on(&self, date: &str) -> Option<&RateEntry> {
        self.rates.iter().rfind(|rate| rate.date.as_str() <= date)
    }

    /// The entry an event's rates came from. Events recorded before rates kept their entry's id
    /// fall back to the entry in force on their date.
    pub fn rates_of(&self, recorded: Option<&RecordedRates>, date: &str) -> Option<&RateEntry> {
        match recorded.and_then(|rates| rates.rates_id.as_deref()) {
            Some(id) => self.rates.iter().find(|rate| rate.id == id),
            None => self.rates_on(date),
        }
    }

    pub fn pair_state(&self, x: &str, y: &str) -> PairState {
        let (low, high) = pair_key(x, y);
        self.pairs
            .get(&(low.clone(), high.clone()))
            .cloned()
            .unwrap_or_else(|| PairState::new(&low, &high))
    }

    /// A group the caller belongs to. Any other group does not exist as far as they can tell.
    pub fn visible_group(&self, group_id: &str, me: &str) -> Result<&Group> {
        self.groups
            .get(group_id)
            .filter(|group| group.member_ids.iter().any(|id| id == me))
            .ok_or_else(|| ApiError::not_found("The group was not found."))
    }
}

/// The members who are still on the allowlist.
pub async fn active_members<T: Table>(
    table: &T,
    members: &BTreeMap<String, Member>,
) -> Result<HashSet<String>> {
    let by_key: HashMap<Key, &String> = members
        .values()
        .map(|member| (keys::allowlist(&member.email), &member.id))
        .collect();
    let wanted: Vec<Key> = by_key.keys().cloned().collect();
    let mut active = HashSet::new();
    for item in table.batch_get(&wanted).await? {
        if let Some(id) = by_key.get(&Key::of(&item)?) {
            active.insert((*id).clone());
        }
    }
    Ok(active)
}

/// The payments behind every unused credit in these pairs, which a new debt may draw on.
pub async fn payments_behind_credits<'a, T: Table>(
    table: &T,
    pairs: impl Iterator<Item = &'a PairState>,
) -> Result<HashMap<String, Payment>> {
    let wanted: Vec<Key> = pairs
        .flat_map(|pair| pair.credits.iter())
        .map(|credit| keys::payment(&credit.payment_id))
        .collect();
    let mut payments = HashMap::new();
    if wanted.is_empty() {
        return Ok(payments);
    }
    for item in table.batch_get(&wanted).await? {
        let mut payment: Payment = from_item(&item)?;
        payment.id = id_after(&item, "PAYMENT#")?.to_string();
        payments.insert(payment.id.clone(), payment);
    }
    Ok(payments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Stamp;

    fn entry(id: &str, date: &str, seq: u64) -> RateEntry {
        RateEntry {
            id: id.to_string(),
            usd_cad: "1.4000".to_string(),
            cad_clp: "670.00".to_string(),
            date: date.to_string(),
            entered_by: None,
            fetched_at: None,
            seq,
            stamp: Stamp::default(),
        }
    }

    fn view() -> LedgerView {
        LedgerView {
            rates: vec![
                entry("morning", "2026-11-18", 1),
                entry("evening", "2026-11-18", 2),
            ],
            ..LedgerView::default()
        }
    }

    #[test]
    fn an_event_names_the_entry_it_recorded_even_on_a_day_with_several() {
        let recorded = view().rates[0].recorded();
        let found = view()
            .rates_of(Some(&recorded), "2026-11-18")
            .map(|rate| rate.id.clone());
        assert_eq!(found.as_deref(), Some("morning"));
    }

    #[test]
    fn an_event_recorded_before_entries_were_named_uses_its_date() {
        let mut recorded = view().rates[0].recorded();
        recorded.rates_id = None;
        let found = view()
            .rates_of(Some(&recorded), "2026-11-18")
            .map(|rate| rate.id.clone());
        assert_eq!(found.as_deref(), Some("evening"));
    }
}
