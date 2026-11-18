# API contract

Routes are unversioned under `/api`. The OpenAPI document inline in `templates/api/stack.yaml` is the source of truth.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | None | Confirms the API is reachable |
| `GET /api/me` | Cognito | The signed-in family member |
| `POST /api/auth/session` | None | Exchanges an authorization code and sets the session cookie |
| `POST /api/auth/session/refresh` | Session cookie | Returns a fresh ID token |
| `DELETE /api/auth/session` | Session cookie | Revokes the session and clears the cookie |

## Errors

Every non-2xx response with a body has this shape:

```json
{ "error": { "code": "forbidden", "message": "This action is not allowed." } }
```

`code` is the stable contract and the frontend translates it. `message` is English diagnostic text and is never shown to users.

| Code | Status |
|---|---|
| `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `too_many_requests` | 429 |
| `request_error` | Other 4xx |
| `internal_error` | 5xx |
