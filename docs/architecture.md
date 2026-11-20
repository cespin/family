# Architecture

## Overview

```text
Browser ── CloudFront ─┬─ /*      ── S3 (React build)
                       └─ /api/*  ── API Gateway ── Rust Lambdas ── DynamoDB
                                          │
                                          └─ Cognito authorizer ── Google sign-in
```

The browser and the API share one origin, so there is no CORS. Everything is serverless and billed by use, with no VPC or always-on compute.

## Verticals

| Vertical | Owns |
|---|---|
| `bootstrap` | Build artifacts bucket |
| `certificate` | TLS certificate for CloudFront |
| `data` | The DynamoDB table |
| `security` | Cognito user pool, Google federation and the allowlist triggers |
| `api` | REST API and its Lambdas |
| `hosting` | S3, CloudFront, security headers and DNS |

Verticals share values through CloudFormation exports named `fam-main-<Name>`.

## Adding a dashboard module

A module such as shared photos or finances is a vertical slice:

1. **Data:** choose a key prefix and document it in `backend/docs/dynamodb-schema.md`.
2. **API:** add a crate under `backend/functions/`, then add it to the workspace, to `FUNCTIONS` in `scripts/build-functions.sh`, and to `templates/api/stack.yaml` with its route, role and log group. Protect the route with the `CognitoUserPool` authorizer and re-check the caller with `family_core::claims::Caller`.
3. **Contract:** document the route in `backend/docs/api-contract.md`. Any new error code needs a translation.
4. **Frontend:** add a screen under `frontend/web/src/screens/` and a catalog namespace under `frontend/web/src/i18n/locales/<locale>/`.

Before storing family data, decide its backup and retention needs. Files and photos belong in S3 behind presigned URLs, not in DynamoDB. Money is stored as integer minor units with its currency.

## Decisions

- **No origin mutual TLS.** The API's default endpoint stays reachable, protected by the Cognito authorizer, the origin check on session routes and stage throttling.
- **One environment.** `main` is production. A second environment would be a new var file in `backend/stacks/`.
- **Private by default.** Every response carries `X-Robots-Tag: noindex`, and staged frontend builds are unlisted rather than access-controlled, so family data must never be baked into a build.
- **Financial records are kept indefinitely,** as section 8 of `docs/frontend-requirements.md` sets out. The expenses design is in `backend/docs/dynamodb-schema.md` and `backend/docs/api-contract.md`.
