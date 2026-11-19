//! Dividing an expense among its participants. Shares always add up to exactly the total.

use std::collections::BTreeMap;

use super::exact;

/// Rounds down, and hands any remainder one unit at a time to the first participants.
pub fn split_equal(total: i64, participant_ids: &[String]) -> BTreeMap<String, i64> {
    let count = participant_ids.len() as i64;
    let each = total / count;
    let remainder = total - each * count;
    participant_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), each + i64::from((index as i64) < remainder)))
        .collect()
}

/// Rounds each share, and the largest share absorbs the difference. The first of a tie takes it.
pub fn split_percent(
    total: i64,
    participant_ids: &[String],
    percents: &BTreeMap<String, i64>,
) -> BTreeMap<String, i64> {
    let mut shares: BTreeMap<String, i64> = participant_ids
        .iter()
        .map(|id| {
            let percent = percents.get(id).copied().unwrap_or(0);
            let share = exact::whole(total) * exact::whole(percent) / exact::whole(100);
            (id.clone(), exact::round(&share))
        })
        .collect();
    let assigned: i64 = shares.values().sum();
    let mut largest = &participant_ids[0];
    for id in participant_ids {
        if shares[id] > shares[largest] {
            largest = id;
        }
    }
    let largest = largest.clone();
    *shares.entry(largest).or_insert(0) += total - assigned;
    shares
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn percents(values: &[(&str, i64)]) -> BTreeMap<String, i64> {
        values
            .iter()
            .map(|(id, value)| (id.to_string(), *value))
            .collect()
    }

    #[test]
    fn an_equal_split_gives_the_remainder_to_the_first_participants() {
        let shares = split_equal(10000, &ids(&["diego", "lucia", "mama"]));
        assert_eq!(
            (shares["diego"], shares["lucia"], shares["mama"]),
            (3334, 3333, 3333)
        );
    }

    #[test]
    fn the_largest_share_absorbs_the_rounding() {
        let order = ids(&["diego", "lucia", "mama"]);
        let shares = split_percent(
            10001,
            &order,
            &percents(&[("diego", 33), ("lucia", 33), ("mama", 34)]),
        );
        assert_eq!(
            (shares["diego"], shares["lucia"], shares["mama"]),
            (3300, 3300, 3401)
        );
    }

    #[test]
    fn a_tie_resolves_in_group_order() {
        let order = ids(&["diego", "lucia"]);
        let shares = split_percent(10001, &order, &percents(&[("diego", 50), ("lucia", 50)]));
        assert_eq!((shares["diego"], shares["lucia"]), (5000, 5001));
    }
}
