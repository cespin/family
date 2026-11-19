//! `POST /api/groups` and `PUT /api/groups/{groupId}`.

use std::collections::{BTreeMap, HashSet};

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::consistent_read;
use crate::model::{Group, Stamp};
use crate::protocol::read::read_head;
use crate::protocol::request_hash::request_hash;
use crate::protocol::write::{commit, kept_losing, Commit, WritePlan, WRITE_TRIES};
use crate::rules::standing::standings_for;
use crate::rules::validate::{
    invalid, is_uuid, no_duplicates, require_percentages, require_request_id, required_name,
};
use crate::service::access::{member_of, Signed};
use crate::service::reads::group_json;
use crate::service::view::{active_members, LedgerView};
use crate::store::keys;
use crate::store::table::{from_item, to_item, Table};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewGroupRequest {
    request_id: String,
    name: String,
    member_ids: Vec<String>,
    usual_split: Option<BTreeMap<String, i64>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupEditRequest {
    request_id: String,
    name: String,
    member_ids: Vec<String>,
    version: u64,
    usual_split: Option<BTreeMap<String, i64>>,
}

fn with_revision(group: &Group, rev: u64) -> Value {
    let mut body = group_json(group);
    body["revision"] = json!(rev);
    body
}

fn require_known(ids: &[&String], view: &LedgerView, active: &HashSet<String>) -> Result<()> {
    if ids
        .iter()
        .all(|id| view.members.contains_key(*id) && active.contains(*id))
    {
        Ok(())
    } else {
        invalid("Every member of a group must be a current family member.")
    }
}

pub async fn post_group<T: Table>(table: &T, caller: &Caller, raw: Value) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let me = &signed.member_id;
    let hash = request_hash(&raw);
    let request: NewGroupRequest = serde_json::from_value(raw)?;
    require_request_id(&request.request_id)?;
    let name = required_name(&request.name, "group name")?;
    no_duplicates(&request.member_ids, "members")?;
    if request.member_ids.len() < 2 || !request.member_ids.contains(me) {
        return invalid("A group needs at least two members, including its creator.");
    }
    if let Some(split) = &request.usual_split {
        require_percentages(split, &request.member_ids)?;
    }
    let key = keys::group(&request.request_id);

    for _ in 0..WRITE_TRIES {
        if let Some(item) = table.get(&key).await? {
            let mut saved: Group = from_item(&item)?;
            saved.id = request.request_id.clone();
            if saved.stamp.last_request_hash.as_deref() != Some(&hash) || saved.created_by != *me {
                return Err(ApiError::conflict(
                    "This requestId was used for something else.",
                ));
            }
            return Ok(with_revision(&saved, read_head(table).await?.rev));
        }

        let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
        let active = active_members(table, &view.members).await?;
        require_known(
            &request.member_ids.iter().collect::<Vec<_>>(),
            &view,
            &active,
        )?;

        let new_rev = rev + 1;
        let group = Group {
            id: request.request_id.clone(),
            name: name.clone(),
            created_by: me.clone(),
            member_ids: request.member_ids.clone(),
            usual_split: request.usual_split.clone(),
            version: 1,
            seq: new_rev,
            stamp: Stamp {
                rev: new_rev,
                last_request_id: Some(request.request_id.clone()),
                last_request_hash: Some(hash.clone()),
            },
        };
        let plan = WritePlan {
            items: vec![to_item(&key, &group, new_rev)?],
            unstamped: Vec::new(),
        };
        if commit(table, rev, &signed.email, plan).await? == Commit::Saved {
            return Ok(with_revision(&group, new_rev));
        }
    }
    Err(kept_losing())
}

/// The usual split after a change of members, following sections 7 and 12 of the requirements.
fn next_split(
    group: &Group,
    request: &GroupEditRequest,
    removed: bool,
) -> Result<Option<BTreeMap<String, i64>>> {
    if let Some(split) = &request.usual_split {
        require_percentages(split, &request.member_ids)?;
        return Ok(Some(split.clone()));
    }
    if removed {
        return Ok(None);
    }
    Ok(group.usual_split.as_ref().map(|split| {
        request
            .member_ids
            .iter()
            .map(|id| (id.clone(), split.get(id).copied().unwrap_or(0)))
            .collect()
    }))
}

async fn edit_once<T: Table>(
    table: &T,
    signed: &Signed,
    group_id: &str,
    request: &GroupEditRequest,
    name: &str,
    hash: &str,
) -> Result<Option<Value>> {
    let me = &signed.member_id;
    let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
    let group = view.visible_group(group_id, me)?;

    if group.stamp.last_request_id.as_deref() == Some(&request.request_id) {
        if group.stamp.last_request_hash.as_deref() == Some(hash) && group.created_by == *me {
            return Ok(Some(with_revision(group, rev)));
        }
        return Err(ApiError::conflict(
            "This requestId was used for something else.",
        ));
    }
    if group.created_by != *me {
        return Err(ApiError::forbidden("only the creator can change a group"));
    }
    if group.version != request.version {
        return Err(ApiError::conflict("The group changed since it was read."));
    }
    if !request.member_ids.contains(&group.created_by) {
        return invalid("The creator cannot be removed from the group.");
    }

    let added: Vec<&String> = request
        .member_ids
        .iter()
        .filter(|id| !group.member_ids.contains(id))
        .collect();
    let active = active_members(table, &view.members).await?;
    require_known(&added, &view, &active)?;

    let removed: Vec<&String> = group
        .member_ids
        .iter()
        .filter(|id| !request.member_ids.contains(id))
        .collect();
    for member_id in &removed {
        let open = standings_for(&view.pairs, member_id)
            .values()
            .flatten()
            .any(|entry| entry.group_id.as_deref() == Some(group_id));
        if open {
            return Err(ApiError::MemberHasOpenBalance(
                "A member with an open balance cannot leave the group.".to_string(),
            ));
        }
    }

    let new_rev = rev + 1;
    let changed = Group {
        name: name.to_string(),
        member_ids: request.member_ids.clone(),
        usual_split: next_split(group, request, !removed.is_empty())?,
        version: group.version + 1,
        stamp: Stamp {
            rev: new_rev,
            last_request_id: Some(request.request_id.clone()),
            last_request_hash: Some(hash.to_string()),
        },
        ..group.clone()
    };
    let plan = WritePlan {
        items: vec![to_item(&keys::group(group_id), &changed, new_rev)?],
        unstamped: Vec::new(),
    };
    match commit(table, rev, &signed.email, plan).await? {
        Commit::Saved => Ok(Some(with_revision(&changed, new_rev))),
        Commit::Contended => Ok(None),
    }
}

pub async fn put_group<T: Table>(
    table: &T,
    caller: &Caller,
    group_id: &str,
    raw: Value,
) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let hash = request_hash(&raw);
    let request: GroupEditRequest = serde_json::from_value(raw)?;
    if !is_uuid(group_id) {
        return Err(ApiError::not_found("The group was not found."));
    }
    require_request_id(&request.request_id)?;
    let name = required_name(&request.name, "group name")?;
    no_duplicates(&request.member_ids, "members")?;
    if request.member_ids.len() < 2 {
        return invalid("A group needs at least two members.");
    }

    for _ in 0..WRITE_TRIES {
        if let Some(body) = edit_once(table, &signed, group_id, &request, &name, &hash).await? {
            return Ok(body);
        }
    }
    Err(kept_losing())
}
