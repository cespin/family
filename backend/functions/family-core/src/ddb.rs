//! DynamoDB access. The item layout is documented in `backend/docs/dynamodb-schema.md`.

use std::future::Future;

use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client;

use crate::{ApiError, Result};

const MEMBER_SORT_KEY: &str = "PROFILE";

/// The allowlist's partition key. Addresses are compared lowercased.
pub fn member_partition_key(email: &str) -> String {
    format!("MEMBER#{}", email.trim().to_lowercase())
}

/// The invite-only allowlist.
pub trait Members: Send + Sync {
    fn is_member(&self, email: &str) -> impl Future<Output = Result<bool>> + Send;
}

pub struct DynamoMembers {
    client: Client,
    table_name: String,
}

impl DynamoMembers {
    pub fn new(client: Client, table_name: String) -> Self {
        Self { client, table_name }
    }
}

impl Members for DynamoMembers {
    async fn is_member(&self, email: &str) -> Result<bool> {
        let item = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .key("PK", AttributeValue::S(member_partition_key(email)))
            .key("SK", AttributeValue::S(MEMBER_SORT_KEY.to_string()))
            .projection_expression("PK")
            // A removal must take effect immediately.
            .consistent_read(true)
            .send()
            .await
            .map_err(|e| ApiError::internal(format!("allowlist read failed: {e:?}")))?;
        Ok(item.item.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_keys_ignore_case_and_surrounding_space() {
        assert_eq!(
            member_partition_key(" Ana@Example.TEST "),
            "MEMBER#ana@example.test"
        );
    }
}
