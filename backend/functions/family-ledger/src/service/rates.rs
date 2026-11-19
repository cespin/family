//! `POST /api/exchange-rates`.

use family_core::claims::Caller;
use family_core::{ApiError, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::consistent_read;
use crate::model::{RateEntry, Stamp};
use crate::protocol::read::read_head;
use crate::protocol::request_hash::request_hash;
use crate::protocol::write::{commit, kept_losing, Commit, WritePlan, WRITE_TRIES};
use crate::rules::validate::{require_date, require_rate, require_request_id};
use crate::service::access::member_of;
use crate::service::reads::rate_json;
use crate::service::view::LedgerView;
use crate::store::keys;
use crate::store::table::{from_item, to_item, Table};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RatesRequest {
    request_id: String,
    usd_cad: String,
    cad_clp: String,
    date: String,
}

pub async fn post_rates<T: Table>(table: &T, caller: &Caller, raw: Value) -> Result<Value> {
    let signed = member_of(table, caller).await?;
    let hash = request_hash(&raw);
    let request: RatesRequest = serde_json::from_value(raw)?;
    require_request_id(&request.request_id)?;
    require_rate(&request.usd_cad)?;
    require_rate(&request.cad_clp)?;
    require_date(&request.date)?;
    let key = keys::rate(&request.request_id);

    for _ in 0..WRITE_TRIES {
        if let Some(item) = table.get(&key).await? {
            let mut saved: RateEntry = from_item(&item)?;
            saved.id = request.request_id.clone();
            if saved.stamp.last_request_hash.as_deref() != Some(&hash)
                || saved.entered_by != signed.member_id
            {
                return Err(ApiError::conflict(
                    "This requestId was used for something else.",
                ));
            }
            let mut body = rate_json(&saved);
            body["revision"] = json!(read_head(table).await?.rev);
            return Ok(body);
        }

        let (rev, view) = consistent_read!(table, session, LedgerView::load(&mut session).await?);
        let new_rev = rev + 1;
        // An entry dated before the latest one takes the latest one's date.
        let latest = view.rates.last().map(|rate| rate.date.as_str());
        let date = match latest {
            Some(latest) if request.date.as_str() < latest => latest.to_string(),
            _ => request.date.clone(),
        };
        let entry = RateEntry {
            id: request.request_id.clone(),
            usd_cad: request.usd_cad.clone(),
            cad_clp: request.cad_clp.clone(),
            date,
            entered_by: signed.member_id.clone(),
            seq: new_rev,
            stamp: Stamp {
                rev: new_rev,
                last_request_id: Some(request.request_id.clone()),
                last_request_hash: Some(hash.clone()),
            },
        };
        let plan = WritePlan {
            items: vec![to_item(&key, &entry, new_rev)?],
            unstamped: Vec::new(),
        };
        if commit(table, rev, &signed.email, plan).await? == Commit::Saved {
            let mut body = rate_json(&entry);
            body["revision"] = json!(new_rev);
            return Ok(body);
        }
    }
    Err(kept_losing())
}
