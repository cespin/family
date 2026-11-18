---
name: api-design
description: Design and review REST endpoints for the family dashboard API. Use when adding or changing a route under /api, a request or response shape, an error code, authentication on a route, or the inline OpenAPI document in backend/templates/api/stack.yaml.
metadata:
  origin: ECC
---

# API Design Patterns

The conventions this API actually follows. Paths are relative to `backend/`.

The OpenAPI document inline in `templates/api/stack.yaml` is the source of truth, and `docs/api-contract.md` lists the routes and error codes. For the CloudFormation side of a new route, use the `sceptre-developer` skill.

## When to Activate

- Designing a new endpoint
- Reviewing an existing API contract
- Adding or changing an error code
- Deciding how a route is authenticated
- Adding the first list endpoint, filter or pagination

## Resource Design

### URL Structure

Routes are unversioned and live under `/api`. Today's routes are all singletons with singular names, such as `/api/me` and `/api/auth/session`. For a future collection, use plural, lowercase nouns in kebab-case. The routes below are illustrative and do not exist yet.

```
GET    /api/shopping-lists
GET    /api/shopping-lists/{listId}
POST   /api/shopping-lists
PATCH  /api/shopping-lists/{listId}
DELETE /api/shopping-lists/{listId}

# Sub-resources for relationships
GET    /api/shopping-lists/{listId}/items

# Actions that don't map to CRUD (use sparingly)
POST   /api/auth/session/refresh
```

```
# BAD
/api/v1/shopping-lists        # no version prefix in this API
/api/getShoppingLists         # verb in URL
/api/shopping_lists           # snake_case in URLs
```

There is no versioning scheme. An open browser tab keeps running the bundle it loaded, so prefer additive changes: add optional fields, and remove a field only after no deployed frontend reads it.

## HTTP Methods and Status Codes

| Method | Idempotent | Safe | Use For |
|--------|-----------|------|---------|
| GET | Yes | Yes | Retrieve resources |
| POST | No | No | Create resources, trigger actions |
| PUT | Yes | No | Full replacement of a resource |
| PATCH | No | No | Partial update of a resource |
| DELETE | Yes | No | Remove a resource |

```
200 OK                 GET, PUT, PATCH, and POST actions that return a body
201 Created            POST that creates a resource
204 No Content         Success with no body. Use http::no_content()

400 validation_error   Malformed or invalid input. This API does not use 422
401 unauthorized       Missing, invalid or expired authentication
403 forbidden          Authenticated but not allowed
404 not_found          Resource or route doesn't exist
409 conflict           State conflict
429 too_many_requests  Stage throttling, produced by API Gateway
500 internal_error     Unexpected failure. Details are logged, never returned
```

## Response Format

### Success Response

Success bodies are the resource itself, with no `data` wrapper. Field names are camelCase through `#[serde(rename_all = "camelCase")]`.

```json
{ "sub": "abc-123", "email": "<address>", "name": "<display name>" }
```

Every Lambda response carries `Cache-Control: no-store`. Wrap the whole dispatch in `http::no_store` so error responses are covered too.

### Error Response

Every error body uses one envelope, from handlers and from API Gateway alike:

```json
{ "error": { "code": "forbidden", "message": "This action is not allowed." } }
```

- **`code` is the contract.** The frontend translates it into what the user reads. Treat a rename as a breaking change.
- **`message` is English diagnostic text.** It is never shown to users, so don't write it as UI copy or branch on it.
- **There is no `details` array** or per-field error list.
- **Internal, authentication and authorization reasons are redacted.** `ApiError::client_message` returns a fixed message for those variants and the reason only reaches the logs. The messages of `Validation`, `NotFound` and `Conflict` are returned as written, so keep private data out of them.

### Adding an error code

1. Add the variant to `ApiError` in `functions/family-core/src/error.rs`, with arms in `code()` and `status()`. A gateway-only code goes in `x-amazon-apigateway-gateway-responses` in `templates/api/stack.yaml` instead.
2. Add the `errors.*` translation to `common.json` in every locale under `../frontend/web/src/i18n/locales/`.
3. Add the code to the table in `docs/api-contract.md`.

The test `translates every error code the backend can return` in `../frontend/web/src/i18n/i18n.test.js` enforces step 2, but it finds codes by matching text. Keep the two existing spellings, `Self::Variant(_) => "code"` in Rust and `"code": "value"` in the template, or a new code escapes the check.

An untranslated code does not crash the app: `errorMessage` falls back to the generic message, which is why the test matters.

## Validation

Validate in two layers, both of which answer `400 validation_error`:

- **At the gateway:** declare a schema with `additionalProperties: false` under `components.schemas`, and set `x-amazon-apigateway-request-validator: body-only` on the operation.
- **In the handler:** deserialize with `http::parse_json_body` into a struct with `#[serde(rename_all = "camelCase", deny_unknown_fields)]`.

The `body-only` validator does not check query strings or path parameters, so the handler must validate those itself.

## Pagination, Filtering and Sorting

No route returns a list yet, so no pagination contract exists. When the first one arrives, decide the contract and record it in `docs/api-contract.md`. DynamoDB has no offset, so a cursor built from `LastEvaluatedKey` is the natural fit. Treat the cursor as opaque to the client.

Use query parameters for filtering (`?status=active`), and design the sort key for the order the screen needs.

## Authentication and Authorization

| Route kind | OpenAPI | Identity |
|---|---|---|
| Family data | `security: [{ CognitoUserPool: [] }]` | `Caller::from_request` |
| Session routes under `/api/auth/session` | no `security` key | Session cookie and an `Origin` check |
| `GET /api/health` | no `security` key | None, and it touches no data |

- **Identity comes only from the authorizer's claims,** through `family_core::claims::Caller`. Never take it from a body, a query string or a self-parsed header.
- **The authorizer expects the ID token.** The empty scope list makes API Gateway validate an ID token, and `../frontend/web/src/lib/api.js` sends it as the raw `Authorization` value with no `Bearer` prefix.
- **A valid token does not prove current membership.** `functions/me-get/src/main.rs` re-reads the allowlist through `Members::is_member`, so a removed member is refused while their token is still valid. Do the same on any route that returns or changes family data.
- **The browser and the API share one origin,** so there is no CORS configuration.

## Rate Limiting

Throttling is set on the stage by `scripts/deploy-vertical.sh`, at 10 requests per second with a burst of 20. Exceeding it returns `429 too_many_requests`. Responses carry no `X-RateLimit-*` headers.

## Implementation Pattern

One crate per Lambda, kept thin. The handler is generic over its dependencies so tests can use a fake, as in `functions/me-get/src/main.rs`:

```rust
use family_core::claims::Caller;
use family_core::ddb::Members;
use family_core::{http, ApiError, Result};
use lambda_http::{Body, Error, Request, Response};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThingResponse<'a> {
    display_name: &'a str,
}

async fn dispatch<M: Members>(members: &M, event: &Request) -> Result<Response<Body>> {
    let caller = Caller::from_request(event)?;
    if !members.is_member(&caller.email).await? {
        return Err(ApiError::forbidden(format!(
            "sub {} is no longer on the allowlist",
            caller.sub
        )));
    }
    Ok(http::json_response(200, &ThingResponse { display_name: "example" }))
}

async fn function_handler<M: Members>(
    members: &M,
    event: Request,
) -> std::result::Result<Response<Body>, Error> {
    Ok(http::no_store(
        dispatch(members, &event)
            .await
            .unwrap_or_else(|err| http::error_response(&err)),
    ))
}
```

A handler returns `Ok` even for a failed request, because the error has already become a response. Never log a request body, a `Cookie` header or a token.

## API Design Checklist

Before shipping a new endpoint:

- [ ] URL follows the naming rules: under `/api`, unversioned, plural, kebab-case
- [ ] Correct method and status codes
- [ ] Body validated at the gateway and in the handler, and query and path parameters validated in the handler
- [ ] Errors use `ApiError`, so they share the envelope
- [ ] Any new `code` has an `errors.*` translation in every locale
- [ ] Route has the `CognitoUserPool` authorizer, or a stated reason not to
- [ ] Caller comes from `Caller::from_request`, and allowlist membership is re-checked
- [ ] Response is wrapped in `http::no_store` and leaks no internal detail
- [ ] Fields are camelCase and consistent with existing routes
- [ ] Handler tests use a hand-written fake and cover the refusal paths
- [ ] `docs/api-contract.md` is updated
