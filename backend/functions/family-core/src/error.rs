//! The error type handlers return, and its mapping onto the wire.
//!
//! `code` is the stable contract with the frontend, which translates it. `message` is English
//! diagnostic text that users never see. A new code needs an `errors.*` translation in
//! `frontend/web/src/i18n/locales`, and a frontend test reads this file to enforce that.

pub const GENERIC_ERROR_MESSAGE: &str = "An unexpected error occurred.";
pub const GENERIC_AUTH_ERROR_MESSAGE: &str = "Authentication is required.";
pub const FORBIDDEN_MESSAGE: &str = "This action is not allowed.";

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    Validation(String),
    /// The reason is logged and never returned, so failures cannot be told apart from outside.
    #[error("{0}")]
    Unauthorized(String),
    /// The reason is logged and never returned.
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    /// A member cannot leave a group while they still owe or are owed money in it.
    #[error("{0}")]
    MemberHasOpenBalance(String),
    /// The reason is logged and never returned.
    #[error("{0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, ApiError>;

impl ApiError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation_error",
            Self::Unauthorized(_) => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::MemberHasOpenBalance(_) => "member_has_open_balance",
            Self::Internal(_) => "internal_error",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::Validation(_) => 400,
            Self::Unauthorized(_) => 401,
            Self::Forbidden(_) => 403,
            Self::NotFound(_) => 404,
            Self::Conflict(_) | Self::MemberHasOpenBalance(_) => 409,
            Self::Internal(_) => 500,
        }
    }

    /// What the client may see. Authentication, authorization and internal details are redacted.
    pub fn client_message(&self) -> String {
        match self {
            Self::Internal(_) => GENERIC_ERROR_MESSAGE.to_string(),
            Self::Unauthorized(_) => GENERIC_AUTH_ERROR_MESSAGE.to_string(),
            Self::Forbidden(_) => FORBIDDEN_MESSAGE.to_string(),
            other => other.to_string(),
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::Unauthorized(msg.into())
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::Forbidden(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::Conflict(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        Self::Validation(format!("The request body is not valid: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    const API_TEMPLATE: &str = include_str!("../../../templates/api/stack.yaml");

    #[rstest]
    #[case(ApiError::Validation("v".into()), 400, "validation_error")]
    #[case(ApiError::Unauthorized("u".into()), 401, "unauthorized")]
    #[case(ApiError::Forbidden("f".into()), 403, "forbidden")]
    #[case(ApiError::NotFound("n".into()), 404, "not_found")]
    #[case(ApiError::Conflict("c".into()), 409, "conflict")]
    #[case(ApiError::MemberHasOpenBalance("m".into()), 409, "member_has_open_balance")]
    #[case(ApiError::Internal("i".into()), 500, "internal_error")]
    fn every_variant_maps_to_its_status_and_code(
        #[case] err: ApiError,
        #[case] status: u16,
        #[case] code: &str,
    ) {
        assert_eq!(err.status(), status);
        assert_eq!(err.code(), code);
    }

    #[rstest]
    #[case(
        ApiError::internal("table main-fa01-family throttled"),
        GENERIC_ERROR_MESSAGE
    )]
    #[case(
        ApiError::unauthorized("token expired for sub abc"),
        GENERIC_AUTH_ERROR_MESSAGE
    )]
    #[case(
        ApiError::forbidden("someone is not on the allowlist"),
        FORBIDDEN_MESSAGE
    )]
    fn sensitive_reasons_never_reach_the_client(#[case] err: ApiError, #[case] expected: &str) {
        assert_eq!(err.client_message(), expected);
    }

    #[rstest]
    #[case(GENERIC_ERROR_MESSAGE)]
    #[case(GENERIC_AUTH_ERROR_MESSAGE)]
    #[case(FORBIDDEN_MESSAGE)]
    fn handler_messages_match_the_gateway_responses(#[case] message: &str) {
        assert!(
            API_TEMPLATE.contains(message),
            "{message} is not in the API template"
        );
    }
}
