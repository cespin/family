//! Environment configuration, read once at cold start.

use crate::{ApiError, Result};

/// A required environment variable. A missing one is a deployment error, so callers fail init
/// rather than rejecting every request for the life of the sandbox.
pub fn required_env(name: &str) -> Result<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(ApiError::internal(format!(
            "missing environment variable {name}"
        ))),
    }
}
