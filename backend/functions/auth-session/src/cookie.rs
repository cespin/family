//! The session cookie that carries the Cognito refresh token.
//!
//! `Path=/api/auth/session` confines the token to these routes, so no other Lambda's event can
//! carry it into the logs. `__Secure-` is used instead of `__Host-` because `__Host-` requires
//! `Path=/`.

pub(crate) const COOKIE_NAME: &str = "__Secure-fa_session";

/// 7 days. Must equal `RefreshTokenValidity` in `templates/security/stack.yaml`, because Cognito's
/// validity does not slide on use. A test below reads the template to enforce it.
pub(crate) const MAX_AGE_SECONDS: u32 = 604_800;

/// Shared by set and clear: a `Path` mismatch would leave the original cookie in place.
const ATTRIBUTES: &str = "HttpOnly; Secure; SameSite=Strict; Path=/api/auth/session";

pub(crate) fn set(refresh_token: &str) -> String {
    format!("{COOKIE_NAME}={refresh_token}; {ATTRIBUTES}; Max-Age={MAX_AGE_SECONDS}")
}

pub(crate) fn clear() -> String {
    format!("{COOKIE_NAME}=; {ATTRIBUTES}; Max-Age=0")
}

/// The session cookie's value from a `Cookie` header. The name must match exactly.
pub(crate) fn read(header: &str) -> Option<&str> {
    header
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[test]
    fn the_set_cookie_is_exactly_the_contract() {
        assert_eq!(
            set("TOKEN"),
            "__Secure-fa_session=TOKEN; HttpOnly; Secure; SameSite=Strict; \
             Path=/api/auth/session; Max-Age=604800"
        );
    }

    #[test]
    fn clearing_uses_the_same_attributes_as_setting() {
        assert_eq!(
            clear(),
            "__Secure-fa_session=; HttpOnly; Secure; SameSite=Strict; \
             Path=/api/auth/session; Max-Age=0"
        );
    }

    #[test]
    fn reads_its_cookie_among_others() {
        assert_eq!(
            read(&format!("a=1; {COOKIE_NAME}=token; b=2")),
            Some("token")
        );
    }

    #[rstest]
    #[case("fa_session=impostor")]
    #[case("not__Secure-fa_session=impostor")]
    #[case("__Secure-fa_session_v2=impostor")]
    #[case("__Secure-fa_session=")]
    #[case("")]
    fn ignores_lookalike_and_empty_cookies(#[case] header: &str) {
        assert_eq!(read(header), None);
    }

    #[test]
    fn a_value_containing_equals_survives_intact() {
        assert_eq!(
            read(&format!("{COOKIE_NAME}=head.body.sig==")),
            Some("head.body.sig==")
        );
    }

    #[test]
    fn the_max_age_equals_the_pools_refresh_token_validity() {
        let template = include_str!("../../../templates/security/stack.yaml");
        let days: u32 = template
            .lines()
            .find_map(|line| line.trim().strip_prefix("RefreshTokenValidity: "))
            .expect("the template sets RefreshTokenValidity")
            .parse()
            .expect("a number of days");
        assert_eq!(MAX_AGE_SECONDS, days * 24 * 60 * 60);
    }
}
