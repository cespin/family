//! `PUT /api/me/profile`: the first sign-in step, and later changes of home currency or avatar.

use family_core::claims::Caller;
use family_core::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::model::{Member, Stamp};
use crate::protocol::read::read_head;
use crate::protocol::write::{commit, kept_losing, Commit, WritePlan, WRITE_TRIES};
use crate::rules::money::Currency;
use crate::rules::validate::{invalid, required_name};
use crate::service::access::{account_of, read_member};
use crate::service::env::Env;
use crate::service::reads::me;
use crate::store::keys;
use crate::store::table::{to_item, Guard, Item, Table};

const TONES: [&str; 5] = ["clay", "honey", "sage", "lagoon", "cocoa"];

/// The emojis a member can choose as their avatar, and the only list the API checks: the gateway
/// only checks that it is a string. Each is a single code point, so comparing strings is exact. The web
/// app's `src/lib/avatars.js` mirrors it, and `tests/avatars.rs` keeps the two equal. 🙈🙉🙊 are
/// left out because the app gives them their own meanings.
pub const AVATARS: [&str; 48] = [
    "🐵", "🐒", "🦍", "🦧", "🐶", "🐱", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐔",
    "🐧", "🦉", "🦄", "🐝", "🦋", "🐢", "🐙", "🐳", "🐬", "🦒", "🦘", "🦥", "🦦", "🌵", "🌻", "🍄",
    "🍉", "🍓", "🍕", "🌮", "🍩", "☕", "⚽", "🎸", "🎨", "🚀", "🌈", "⭐", "😀", "😎", "🤓", "🥳",
];

/// The monkeys members saved before avatars existed get, in the order they signed up.
pub const BACKFILL_MONKEYS: [&str; 4] = ["🐵", "🐒", "🦍", "🦧"];

/// The avatar of a member who finishes the first sign-in step without choosing one.
pub const DEFAULT_AVATAR: &str = BACKFILL_MONKEYS[0];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileRequest {
    home_currency: Currency,
    display_name: Option<String>,
    tone: Option<String>,
    avatar: Option<String>,
}

pub async fn put_profile<T: Table, E: Env>(
    table: &T,
    env: &E,
    caller: &Caller,
    raw: Value,
) -> Result<Value> {
    let request: ProfileRequest = serde_json::from_value(raw)?;
    if let Some(tone) = &request.tone {
        if !TONES.contains(&tone.as_str()) {
            return invalid("The tone is not valid.");
        }
    }
    if let Some(avatar) = &request.avatar {
        if !AVATARS.contains(&avatar.as_str()) {
            return invalid("The avatar is not valid.");
        }
    }

    for _ in 0..WRITE_TRIES {
        // Read first, so anything that changes after this point makes the write retry.
        let rev = read_head(table).await?.rev;
        // A request that lost the race to create the link finds it here and becomes a change.
        let account = account_of(table, caller).await?;
        let existing = match &account.member_id {
            Some(id) => read_member(table, id).await?,
            None => None,
        };
        let display_name = match (&existing, &request.display_name) {
            (Some(_), _) => None,
            (None, Some(name)) => Some(required_name(name, "display name")?),
            (None, None) => return invalid("The display name is required on the first sign-in."),
        };

        let new_rev = rev + 1;
        let (member, unstamped) = match existing {
            // The display name is set once, in the first sign-in step.
            Some(member) => {
                let tone = request.tone.clone().or_else(|| member.tone.clone());
                let avatar = request.avatar.clone().or_else(|| member.avatar.clone());
                if member.home_currency == request.home_currency
                    && member.tone == tone
                    && member.avatar == avatar
                {
                    return me(table, caller).await;
                }
                let changed = Member {
                    home_currency: request.home_currency,
                    tone,
                    avatar,
                    stamp: Stamp {
                        rev: new_rev,
                        ..Stamp::default()
                    },
                    ..member
                };
                (changed, Vec::new())
            }
            None => {
                let member = Member {
                    id: env.new_id(),
                    display_name: display_name.unwrap_or_default(),
                    home_currency: request.home_currency,
                    tone: request.tone.clone(),
                    // A browser from before avatars sends none, and the member still gets one.
                    avatar: Some(
                        request
                            .avatar
                            .clone()
                            .unwrap_or_else(|| DEFAULT_AVATAR.to_string()),
                    ),
                    email: account.email.clone(),
                    created_at: env.now(),
                    stamp: Stamp {
                        rev: new_rev,
                        ..Stamp::default()
                    },
                };
                let link = keys::account(&account.email);
                let mut item = Item::new();
                item.insert("PK".to_string(), json!(link.pk));
                item.insert("SK".to_string(), json!(link.sk));
                item.insert("memberId".to_string(), json!(member.id));
                (member, vec![(item, Guard::Absent)])
            }
        };
        let plan = WritePlan {
            items: vec![to_item(&keys::member(&member.id), &member, new_rev)?],
            unstamped,
        };
        if commit(table, rev, &account.email, plan).await? == Commit::Saved {
            return me(table, caller).await;
        }
    }
    Err(kept_losing())
}
