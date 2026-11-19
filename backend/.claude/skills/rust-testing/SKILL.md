---
name: rust-testing
description: Write and review Rust tests for the family dashboard Lambdas in backend/functions. Use when adding or changing a handler, a family-core helper or a trait such as Members or Sessions, when writing hand-written fakes, rstest cases or tokio tests, or when running or debugging cargo test --workspace.
metadata:
  origin: ECC
---

# Rust Testing Patterns

Patterns for writing reliable, hermetic tests for this workspace, following TDD. Paths are relative to `backend/`, and cargo commands run from `functions/`.

## When to Use

- Writing new Rust functions, methods, or traits
- Adding a test for a handler, or for a bug you are about to fix
- Replacing a real AWS or Cognito call with a fake in a test
- Following TDD workflow in a Lambda crate

## How It Works

1. **Identify target code**: find the function, trait, or module to test
2. **Write a test**: use `#[test]` or `#[tokio::test]` in a `#[cfg(test)]` module, and rstest for parameterized cases
3. **Fake dependencies**: implement the crate's trait by hand in the test module
4. **Run tests (RED)**: verify the test fails with the expected error
5. **Implement (GREEN)**: write minimal code to pass
6. **Refactor**: improve while keeping tests green

## TDD Workflow for Rust

### The RED-GREEN-REFACTOR Cycle

```
RED     → Write a failing test first
GREEN   → Write minimal code to pass the test
REFACTOR → Improve code while keeping tests green
REPEAT  → Continue with next requirement
```

### Step-by-Step TDD in Rust

```rust
// RED: Write test first, use todo!() as placeholder
pub fn add(a: i32, b: i32) -> i32 { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_add() { assert_eq!(add(2, 3), 5); }
}
// cargo test → panics at 'not yet implemented'
```

```rust
// GREEN: Replace todo!() with minimal implementation
pub fn add(a: i32, b: i32) -> i32 { a + b }
// cargo test → PASS, then REFACTOR while keeping tests green
```

## Unit Tests

### Module-Level Test Organization

Tests live in a `#[cfg(test)] mod tests` at the bottom of the file they exercise.

```rust
pub struct Label(String);

impl Label {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("label is empty".to_string());
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_trimmed_text() {
        let label = Label::parse("  groceries ").unwrap();
        assert_eq!(label.as_str(), "groceries");
    }

    #[test]
    fn rejects_blank_input() {
        let result = Label::parse("   ");
        assert!(result.is_err());
        assert!(result.err().unwrap().contains("empty"));
    }
}
```

### Assertion Macros

```rust
assert_eq!(2 + 2, 4);                                    // Equality
assert_ne!(2 + 2, 5);                                    // Inequality
assert!(vec![1, 2, 3].contains(&2));                     // Boolean
assert_eq!(value, 42, "expected 42 but got {value}");    // Custom message
assert!((0.1_f64 + 0.2 - 0.3).abs() < f64::EPSILON);   // Float comparison
```

## Error and Panic Testing

### Testing `Result` Returns

Handlers return `family_core::ApiError`, so assert on what reaches the wire: its status and code.

```rust
#[test]
fn a_blank_body_is_a_validation_error() {
    let err = parse(&request(Body::Empty)).expect_err("rejected");
    assert_eq!(err.status(), 400);
    assert_eq!(err.code(), "validation_error");
}

#[test]
fn parse_succeeds_for_valid_input() -> Result<(), Box<dyn std::error::Error>> {
    let config = parse_config(r#"{"port": 8080}"#)?;
    assert_eq!(config.port, 8080);
    Ok(()) // Test fails if any ? returns Err
}
```

### Testing Panics

```rust
#[test]
#[should_panic(expected = "index out of bounds")]
fn panics_with_specific_message() {
    let v: Vec<i32> = vec![];
    let _ = v[0];
}
```

## Async Tests

### With Tokio

```rust
#[tokio::test]
async fn a_removed_member_is_refused_despite_a_valid_token() {
    let response = function_handler(&FakeMembers(false), signed_in_request())
        .await
        .expect("handler succeeds");
    assert_eq!(response.status(), 403);
}
```

## Test Organization Patterns

### Parameterized Tests with `rstest`

`rstest` is the workspace's table-test tool. It combines with `#[tokio::test]`.

```rust
use rstest::rstest;

#[rstest]
#[case(ApiError::Validation("v".into()), 400, "validation_error")]
#[case(ApiError::NotFound("n".into()), 404, "not_found")]
fn every_variant_maps_to_its_status_and_code(
    #[case] err: ApiError,
    #[case] status: u16,
    #[case] code: &str,
) {
    assert_eq!(err.status(), status);
    assert_eq!(err.code(), code);
}

#[rstest]
#[case(false)]
#[case(true)]
#[tokio::test]
async fn signing_out_always_clears_the_cookie(#[case] revoke_fails: bool) {
    // ...
}
```

### Test Helpers

Keep request builders and body readers as private functions in the test module.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn request(body: Body) -> Request {
        lambda_http::http::Request::builder()
            .method("POST")
            .uri("https://example.test/api/thing")
            .body(body)
            .expect("valid test request")
    }
}
```

## Hand-Written Fakes

Every external call sits behind a small trait, and handlers are generic over it. A test implements the trait by hand, so no mocking library is involved.

```rust
// The smallest useful fake: one canned answer.
struct FakeMembers(bool);

impl Members for FakeMembers {
    async fn is_member(&self, _email: &str) -> Result<bool> {
        Ok(self.0)
    }
}
```

When a test must prove a call did or did not happen, record the calls. Options default to the success path, so each test states only what differs.

```rust
#[derive(Default)]
struct FakeSessions {
    refuse: bool,
    calls: Mutex<Vec<String>>,
}

impl Sessions for FakeSessions {
    async fn refresh(&self, token: &str) -> Result<Tokens> {
        self.calls.lock().unwrap().push(format!("refresh:{token}"));
        // ...
    }
    // exchange and revoke follow the same shape
}

#[tokio::test]
async fn a_refresh_without_a_cookie_never_reaches_cognito() {
    let sessions = FakeSessions::default();
    let response = run(&sessions, refresh_request_without_cookie()).await;
    assert_eq!(response.status(), 401);
    assert!(sessions.calls().is_empty());
}
```

These traits return `impl Future`, so they are not object safe. Take them as a generic parameter (`M: Members`), never as `dyn Members`.

## Doc Tests

Examples in `///` comments on `family-core`'s public items run as tests. The workspace has none today.

```rust
/// Adds two numbers together.
///
/// ```
/// assert_eq!(my_crate::add(2, 3), 5);
/// ```
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

## Testing Commands

```bash
cargo test --workspace                 # Everything. This is the command that must stay green
cargo test -p me-get                   # One crate
cargo test -p auth-session a_refused   # Tests matching a pattern, in one crate
cargo test --workspace -- --nocapture  # Show println output
cargo test --workspace --no-fail-fast  # Don't stop on the first failing crate
```

## Best Practices

**DO:**
- Write tests FIRST (TDD)
- Test behavior, not implementation
- Use descriptive test names that read as the scenario
- Prefer `assert_eq!` over `assert!` for better error messages
- Cover the refusal paths, and assert that a refused request caused no side effect
- Keep tests independent, with no shared mutable state

**DON'T:**
- Use `#[should_panic]` when you can assert on a `Result`
- Build a real AWS client in a test, or read credentials or the network
- Ignore flaky tests: fix them
- Use `sleep()` in tests
- Skip error path testing

## This project

- **`cargo test --workspace` is hermetic.** It passes with no AWS credentials, no AWS configuration and nothing running. Keep it that way: only each crate's `main` builds a real client.
- **Fakes are hand-written, one per crate.** The traits are `Members` in `functions/family-core/src/ddb.rs` and `Sessions` in `functions/auth-session/src/sessions.rs`. See `FakeMembers` in `functions/auth-presignup/src/main.rs`, `FakeSessions` in `functions/auth-session/src/http_handler.rs`, and `FakeTable` in `functions/family-ledger/tests/support/fake_table.rs`. `mockall` is not a dependency.
- **There is no numeric coverage target,** and no coverage tool is configured. Add the test that would catch a wrong behaviour, not one that moves a percentage.
- **Tests can pin a contract across files with `include_str!`.** `functions/family-core/src/error.rs` checks its messages against `templates/api/stack.yaml`, and `functions/auth-session/src/cookie.rs` checks the cookie lifetime against `templates/security/stack.yaml`. Use this when two files must agree.
- **Check a crate's dev-dependencies before you reach for a tool.** `rstest` is declared by `family-core`, `auth-session` and `auth-presignup` only, and `family-core` does not depend on `tokio`, so an async test there needs it added first. Shared versions go in `[workspace.dependencies]` in `functions/Cargo.toml`.
- **New dependencies must pass `scripts/audit-deps.sh`,** which `scripts/build-functions.sh` runs before every build. `proptest` and `criterion` are not in the workspace.
- **The ledger's integration tests live in `functions/family-ledger/tests`.** They run on an in-memory table. Only `tests/ddb_local.rs` needs DynamoDB Local, behind the `ddb-local-tests` feature, and `scripts/test-ddb-local.sh` runs it. `cargo test --workspace` must never need it.
- **Fixtures use fake values only.** `../scripts/check-aws-literals.mjs` has no path exclusions, so a real region or account ID in a test fails the check. Use hosts under `example.test`.

The lint and format commands are listed in `CLAUDE.md`.

**Remember**: Tests are documentation. They show how your code is meant to be used. Write them clearly and keep them up to date.
