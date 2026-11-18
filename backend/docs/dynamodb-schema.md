# DynamoDB schema

One table, `main-fa01-family`, with string keys `PK` and `SK`. The `expiresAt` attribute is the TTL.

| Entity | PK | SK | Attributes |
|---|---|---|---|
| Family member (allowlist) | `MEMBER#<lowercased email>` | `PROFILE` | `email`, `addedAt` |

New modules add their own `PK` prefix here.
