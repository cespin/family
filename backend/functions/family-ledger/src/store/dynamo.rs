//! The table on DynamoDB.

use std::collections::HashMap;

use aws_sdk_dynamodb::error::SdkError;
use aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError;
use aws_sdk_dynamodb::types::{
    AttributeValue, ConditionCheck, KeysAndAttributes, Put, TransactWriteItem,
};
use aws_sdk_dynamodb::Client;
use family_core::{ApiError, Result};
use serde_json::{Map, Number, Value};

use super::table::{CancelReason, Guard, Item, Key, Page, PageQuery, Table, TxOp, TxOutcome};

const BATCH_GET_LIMIT: usize = 100;

pub struct DynamoTable {
    client: Client,
    table_name: String,
}

impl DynamoTable {
    pub fn new(client: Client, table_name: String) -> Self {
        Self { client, table_name }
    }
}

fn failed(what: &str, error: impl std::fmt::Debug) -> ApiError {
    ApiError::internal(format!("{what} failed: {error:?}"))
}

fn to_attribute(value: &Value) -> Result<AttributeValue> {
    Ok(match value {
        Value::String(text) => AttributeValue::S(text.clone()),
        Value::Number(number) => AttributeValue::N(number.to_string()),
        Value::Bool(flag) => AttributeValue::Bool(*flag),
        Value::Array(items) => {
            AttributeValue::L(items.iter().map(to_attribute).collect::<Result<_>>()?)
        }
        Value::Object(map) => AttributeValue::M(to_attributes(map)?),
        Value::Null => AttributeValue::Null(true),
    })
}

fn to_attributes(item: &Map<String, Value>) -> Result<HashMap<String, AttributeValue>> {
    item.iter()
        .map(|(name, value)| Ok((name.clone(), to_attribute(value)?)))
        .collect()
}

fn from_attribute(attribute: &AttributeValue) -> Result<Value> {
    Ok(match attribute {
        AttributeValue::S(text) => Value::from(text.clone()),
        AttributeValue::N(text) => {
            let number: Number = text
                .parse()
                .map_err(|e| failed("reading a stored number", e))?;
            Value::Number(number)
        }
        AttributeValue::Bool(flag) => Value::from(*flag),
        AttributeValue::Null(_) => Value::Null,
        AttributeValue::L(items) => {
            Value::Array(items.iter().map(from_attribute).collect::<Result<_>>()?)
        }
        AttributeValue::M(map) => Value::Object(from_attributes(map)?),
        other => return Err(failed("reading a stored attribute", other)),
    })
}

fn from_attributes(item: &HashMap<String, AttributeValue>) -> Result<Item> {
    item.iter()
        .map(|(name, value)| Ok((name.clone(), from_attribute(value)?)))
        .collect()
}

fn key_attributes(key: &Key) -> HashMap<String, AttributeValue> {
    HashMap::from([
        ("PK".to_string(), AttributeValue::S(key.pk.clone())),
        ("SK".to_string(), AttributeValue::S(key.sk.clone())),
    ])
}

struct Condition {
    expression: Option<String>,
    values: Option<HashMap<String, AttributeValue>>,
    names: Option<HashMap<String, String>>,
}

fn condition(guard: Guard) -> Condition {
    let plain = |expression: &str| Condition {
        expression: Some(expression.to_string()),
        values: None,
        names: None,
    };
    match guard {
        Guard::None => Condition {
            expression: None,
            values: None,
            names: None,
        },
        Guard::Absent | Guard::Rev(0) => plain("attribute_not_exists(PK)"),
        Guard::Exists => plain("attribute_exists(PK)"),
        Guard::Rev(rev) => Condition {
            expression: Some("#rev = :rev".to_string()),
            values: Some(HashMap::from([(
                ":rev".to_string(),
                AttributeValue::N(rev.to_string()),
            )])),
            names: Some(HashMap::from([("#rev".to_string(), "rev".to_string())])),
        },
    }
}

impl DynamoTable {
    fn transact_item(&self, op: &TxOp) -> Result<TransactWriteItem> {
        match op {
            TxOp::Put { item, guard } => {
                let condition = condition(*guard);
                let put = Put::builder()
                    .table_name(&self.table_name)
                    .set_item(Some(to_attributes(item)?))
                    .set_condition_expression(condition.expression)
                    .set_expression_attribute_values(condition.values)
                    .set_expression_attribute_names(condition.names)
                    .build()
                    .map_err(|e| failed("building a put", e))?;
                Ok(TransactWriteItem::builder().put(put).build())
            }
            TxOp::Check { key, guard } => {
                let condition = condition(*guard);
                let check = ConditionCheck::builder()
                    .table_name(&self.table_name)
                    .set_key(Some(key_attributes(key)))
                    .set_condition_expression(condition.expression)
                    .set_expression_attribute_values(condition.values)
                    .set_expression_attribute_names(condition.names)
                    .build()
                    .map_err(|e| failed("building a condition check", e))?;
                Ok(TransactWriteItem::builder().condition_check(check).build())
            }
        }
    }
}

impl Table for DynamoTable {
    async fn get(&self, key: &Key) -> Result<Option<Item>> {
        let output = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .set_key(Some(key_attributes(key)))
            .consistent_read(true)
            .send()
            .await
            .map_err(|e| failed("reading an item", e))?;
        output.item.as_ref().map(from_attributes).transpose()
    }

    async fn batch_get(&self, keys: &[Key]) -> Result<Vec<Item>> {
        let mut items = Vec::new();
        for chunk in keys.chunks(BATCH_GET_LIMIT) {
            let mut request = KeysAndAttributes::builder().consistent_read(true);
            for key in chunk {
                request = request.keys(key_attributes(key));
            }
            let request = request
                .build()
                .map_err(|e| failed("building a batch read", e))?;
            let mut pending = Some(HashMap::from([(self.table_name.clone(), request)]));
            // A partial answer must never pass for a complete one.
            while let Some(request_items) = pending.take().filter(|keys| !keys.is_empty()) {
                let output = self
                    .client
                    .batch_get_item()
                    .set_request_items(Some(request_items))
                    .send()
                    .await
                    .map_err(|e| failed("reading a batch of items", e))?;
                if let Some(found) = output
                    .responses
                    .as_ref()
                    .and_then(|r| r.get(&self.table_name))
                {
                    for item in found {
                        items.push(from_attributes(item)?);
                    }
                }
                pending = output.unprocessed_keys;
            }
        }
        Ok(items)
    }

    async fn query_page(&self, query: &PageQuery) -> Result<Page> {
        let mut expression = "PK = :pk".to_string();
        let mut values = HashMap::from([(":pk".to_string(), AttributeValue::S(query.pk.clone()))]);
        if let Some(prefix) = &query.prefix {
            expression.push_str(" AND begins_with(SK, :prefix)");
            values.insert(":prefix".to_string(), AttributeValue::S(prefix.clone()));
        } else if let Some(before) = &query.before {
            expression.push_str(" AND SK < :before");
            values.insert(":before".to_string(), AttributeValue::S(before.clone()));
        }
        let output = self
            .client
            .query()
            .table_name(&self.table_name)
            .consistent_read(true)
            .key_condition_expression(expression)
            .set_expression_attribute_values(Some(values))
            .scan_index_forward(!query.descending)
            .set_limit(query.limit.map(|limit| limit as i32))
            .set_exclusive_start_key(query.start_after.as_ref().map(key_attributes))
            .send()
            .await
            .map_err(|e| failed("querying a partition", e))?;
        let items = output
            .items()
            .iter()
            .map(from_attributes)
            .collect::<Result<Vec<_>>>()?;
        let next = match output.last_evaluated_key() {
            Some(key) => match (key.get("PK"), key.get("SK")) {
                (Some(AttributeValue::S(pk)), Some(AttributeValue::S(sk))) => {
                    Some(Key::new(pk.clone(), sk.clone()))
                }
                _ => {
                    return Err(ApiError::internal(
                        "a query returned an unreadable position",
                    ))
                }
            },
            None => None,
        };
        Ok(Page { items, next })
    }

    async fn transact(&self, ops: Vec<TxOp>) -> Result<TxOutcome> {
        let items = ops
            .iter()
            .map(|op| self.transact_item(op))
            .collect::<Result<Vec<_>>>()?;
        let sent = self
            .client
            .transact_write_items()
            .set_transact_items(Some(items))
            .send()
            .await;
        match sent {
            Ok(_) => Ok(TxOutcome::Committed),
            Err(SdkError::ServiceError(service)) => match service.into_err() {
                TransactWriteItemsError::TransactionCanceledException(cancelled) => {
                    let reasons = cancelled
                        .cancellation_reasons()
                        .iter()
                        .map(|reason| match reason.code() {
                            None | Some("None") => Ok(CancelReason::None),
                            Some("ConditionalCheckFailed") => Ok(CancelReason::GuardFailed),
                            Some("TransactionConflict") => Ok(CancelReason::Conflict),
                            Some(other) => Err(failed("a transaction", other)),
                        })
                        .collect::<Result<Vec<_>>>()?;
                    Ok(TxOutcome::Cancelled(reasons))
                }
                TransactWriteItemsError::TransactionInProgressException(_) => {
                    Ok(TxOutcome::Cancelled(vec![CancelReason::Conflict]))
                }
                other => Err(failed("a transaction", other)),
            },
            Err(other) => Err(failed("a transaction", other)),
        }
    }
}
