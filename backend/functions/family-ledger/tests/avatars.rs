//! The list of avatars a member can choose, which the web app offers and this API accepts.

use family_ledger::service::profile::{AVATARS, BACKFILL_MONKEYS, DEFAULT_AVATAR};

/// The web app's copy of the list. A picker offering an emoji the API refuses would fail every
/// save of it, so the two must stay equal.
const WEB_LIST: &str = include_str!("../../../../frontend/web/src/lib/avatars.js");

/// The quoted strings inside `export const AVATARS = [ ... ];`.
fn web_avatars() -> Vec<String> {
    let start = WEB_LIST
        .find("export const AVATARS = [")
        .expect("AVATARS in avatars.js");
    let body = &WEB_LIST[start..];
    let body = &body[body.find('[').unwrap() + 1..body.find("];").unwrap()];
    body.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.trim_matches('\'').to_string())
        .collect()
}

#[test]
fn the_web_app_offers_exactly_the_avatars_the_api_accepts() {
    let web = web_avatars();
    let api: Vec<String> = AVATARS.iter().map(|a| a.to_string()).collect();
    assert_eq!(web, api);
    assert!(
        WEB_LIST.contains(&format!("DEFAULT_AVATAR = '{DEFAULT_AVATAR}'")),
        "the web app starts the first sign-in at {DEFAULT_AVATAR}"
    );
}

#[test]
fn every_avatar_is_one_code_point_and_listed_once() {
    for (index, avatar) in AVATARS.iter().enumerate() {
        assert_eq!(avatar.chars().count(), 1, "{avatar}");
        assert!(!AVATARS[..index].contains(avatar), "{avatar} twice");
    }
}

#[test]
fn the_monkeys_the_app_gives_meanings_to_cannot_be_chosen() {
    for taken in ["🙈", "🙉", "🙊"] {
        assert!(!AVATARS.contains(&taken), "{taken}");
    }
}

#[test]
fn the_backfill_monkeys_and_the_default_can_be_chosen_again() {
    for monkey in BACKFILL_MONKEYS {
        assert!(AVATARS.contains(&monkey), "{monkey}");
    }
    assert!(AVATARS.contains(&DEFAULT_AVATAR));
}
