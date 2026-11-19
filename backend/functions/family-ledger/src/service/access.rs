//! Who is calling. Identity comes only from the verified token, and every route re-reads the
//! allowlist so that removing someone takes effect immediately.

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde_json::Value;

use crate::model::Member;
use crate::store::keys;
use crate::store::table::{from_item, Table};

pub struct Account {
    pub email: String,
    pub member_id: Option<String>,
}

/// The invited account behind a request, whether or not it has finished the first sign-in step.
pub async fn account_of<T: Table>(table: &T, caller: &Caller) -> Result<Account> {
    if table.get(&keys::allowlist(&caller.email)).await?.is_none() {
        return Err(ApiError::forbidden(format!(
            "sub {} is no longer on the allowlist",
            caller.sub
        )));
    }
    let link = table.get(&keys::account(&caller.email)).await?;
    let member_id = link
        .as_ref()
        .and_then(|item| item.get("memberId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Account {
        email: caller.email.trim().to_lowercase(),
        member_id,
    })
}

pub struct Signed {
    pub email: String,
    pub member_id: String,
}

/// The member behind a request. Someone who has not finished signing up is refused.
pub async fn member_of<T: Table>(table: &T, caller: &Caller) -> Result<Signed> {
    let account = account_of(table, caller).await?;
    match account.member_id {
        Some(member_id) => Ok(Signed {
            email: account.email,
            member_id,
        }),
        None => Err(ApiError::forbidden(format!(
            "sub {} has not finished the first sign-in step",
            caller.sub
        ))),
    }
}

pub async fn read_member<T: Table>(table: &T, member_id: &str) -> Result<Option<Member>> {
    let Some(item) = table.get(&keys::member(member_id)).await? else {
        return Ok(None);
    };
    let mut member: Member = from_item(&item)?;
    member.id = member_id.to_string();
    Ok(Some(member))
}
