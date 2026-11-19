# API contract

Routes are unversioned under `/api`. The OpenAPI document inline in `templates/api/stack.yaml` is the source of truth.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | None | Confirms the API is reachable |
| `GET /api/me` | Cognito | The signed-in family member. `memberId`, `displayName` and `homeCurrency` are null until the first-sign-in step is done |
| `PUT /api/me/profile` | Cognito | Completes the first-sign-in step, and later changes the home currency |
| `GET /api/ledger` | Cognito | Members, groups, exchange rates and the caller's balances |
| `GET /api/expenses` | Cognito | One page of expenses, newest first |
| `GET /api/expenses/{expenseId}` | Cognito | One expense in full, with its payments |
| `POST /api/expenses` | Cognito | Adds an expense, answering 201 |
| `PUT /api/expenses/{expenseId}` | Cognito | Edits an expense |
| `GET /api/payments` | Cognito | One page of the caller's own payments, newest first |
| `POST /api/payments` | Cognito | Records a payment, answering 201 |
| `PUT /api/payments/{paymentId}` | Cognito | Corrects the day a payment's money was given |
| `POST /api/groups` | Cognito | Creates a group, answering 201 |
| `PUT /api/groups/{groupId}` | Cognito | Renames a group or changes its members |
| `POST /api/exchange-rates` | Cognito | Enters new exchange rates, answering 201 |
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
| `member_has_open_balance` | 409 |
| `too_many_requests` | 429 |
| `request_error` | Other 4xx |
| `internal_error` | 5xx |

## Family expenses

The rules behind these routes are in `docs/frontend-requirements.md`, and the item layout is in `dynamodb-schema.md`.

Every route uses the `CognitoUserPool` authorizer, re-reads the allowlist and answers with `Cache-Control: no-store`. Apart from `GET /api/me` and `PUT /api/me/profile`, a caller who has not finished the first-sign-in step gets `forbidden`.

### Conventions

- **Money** is an integer in minor units, always next to its currency: `amountMinor` and `currency`. The supported currencies are `CAD`, `USD` and `CLP`.
- **Dates** are calendar dates written `YYYY-MM-DD`, with no time or time zone.
- **Expenses and payments carry two dates.** `date` is the day it was entered, which the browser sends as its own local today and nobody can change. It decides which debts a payment pays first and which rates the detail names. `transactionDate` is the day the money was spent or given, which the member chooses and can correct. It orders the lists and is the date screens show. A request without `transactionDate`, from a browser that predates it, stores its `date`.
- **Exchange rates** are decimal strings, such as `"1.40"`, so no float reaches the money rules.
- **The backend sends data and stable codes**, never display text.
- **Shares are computed by the server.** A request sends participants and percentages, and never sends shares.
- **Bodies are validated twice:** by a gateway schema with `additionalProperties: false`, and by the handler with `deny_unknown_fields`.

### Retries and concurrent edits

- **Every write carries a `requestId`**, a UUID the browser generates once per save and reuses when it retries. On a `POST` it also becomes the new resource's `id`. `PUT /api/me/profile` is the exception, because repeating it changes nothing.
- **A repeated request is safe.** The same `requestId` with the same content returns the saved result with the original success status, such as 201. The same `requestId` with different content returns `conflict`.
- **Expenses, payments and groups carry a `version`.** A `PUT` sends back the version it read, and a stale version returns `conflict`.
- **Saving a usual split through an expense** also increases the group's `version`.

### Pagination

`GET /api/expenses` and `GET /api/payments` return pages. The handler validates their query parameters, because the gateway checks only bodies. `GET /api/expenses` takes these:

| Parameter | Meaning |
|---|---|
| `groupId` | Only this group. Without it, every group the caller belongs to |
| `kind` | Only this kind: `meal`, `parents`, `gift` or `other` |
| `limit` | Page size from 1 to 100. The default is 50 |
| `cursor` | The `nextCursor` of the previous page, sent with the same `groupId` and `kind` |

- **Order** is newest first by `transactionDate`, then by the order they were recorded. `GET /api/payments` uses the same order.
- **`cursor` is opaque.** Send it back unchanged. A cursor that is malformed or belongs to other filters returns `validation_error`.
- **`nextCursor` is null** on the last page.
- **Filters are complete.** Each one reads a list built for it, and the handler keeps reading until the page is full or the list ends.
- **`revision`** is on every response. If a later page has a different `revision` from what is on screen, reload from the first page.

Balances come from `GET /api/ledger` and never depend on how many expenses have been loaded.

### `GET /api/ledger`

```json
{
  "revision": 42,
  "me": "<memberId>",
  "members": [
    { "id": "<memberId>", "displayName": "Tío Beto", "homeCurrency": "USD", "tone": "sage", "active": true }
  ],
  "groups": [
    {
      "id": "<groupId>",
      "name": "Comidas familiares",
      "createdBy": "<memberId>",
      "memberIds": ["<memberId>"],
      "usualSplit": { "<memberId>": 100 },
      "version": 3
    }
  ],
  "exchangeRates": [
    { "id": "<rateId>", "usdCad": "1.40", "cadClp": "670", "date": "2026-11-18", "enteredBy": "<memberId>" }
  ],
  "standings": [
    {
      "memberId": "<memberId>",
      "overall": [{ "amountMinor": -26550, "currency": "CLP" }],
      "groups": [
        { "groupId": "<groupId>", "amounts": [{ "amountMinor": -16800, "currency": "CLP" }] },
        { "groupId": "<groupId>", "amounts": [{ "amountMinor": -9750, "currency": "CLP" }] }
      ]
    }
  ]
}
```

- **`active`** is false for a former member, who stays in the history but cannot be added to a new expense or group. A payment with them is still accepted, so an old debt can always be cleared.
- **`exchangeRates`** runs newest first, so the first entry is the current one. It is empty until rates are entered.
- **`standings`** amounts stay in their original currencies. Positive means that member owes the caller. A `groupId` of null is credit between two people who share no group.

### `GET /api/expenses`

```json
{
  "revision": 42,
  "expenses": [
    {
      "id": "<expenseId>",
      "title": "Almuerzo familiar del domingo",
      "kind": "meal",
      "groupId": "<groupId>",
      "payerId": "<memberId>",
      "addedBy": "<memberId>",
      "amountMinor": 84000,
      "currency": "CLP",
      "date": "2026-11-08",
      "transactionDate": "2026-11-08",
      "participantIds": ["<memberId>"],
      "standing": { "involved": true, "openMinor": -16800, "settled": false }
    }
  ],
  "nextCursor": "<opaque>"
}
```

**`standing.openMinor`** is in the expense's currency. Positive comes back to the caller, negative is owed by the caller, and it is null when the caller is not part of the expense.

### `GET /api/expenses/{expenseId}`

```json
{
  "revision": 42,
  "id": "<expenseId>",
  "title": "Compra con tarjeta canadiense",
  "kind": "other",
  "groupId": "<groupId>",
  "payerId": "<memberId>",
  "addedBy": "<memberId>",
  "amountMinor": 18540,
  "currency": "CAD",
  "otherAmount": { "amountMinor": 120000, "currency": "CLP" },
  "chargedCurrency": "CAD",
  "date": "2026-11-16",
  "transactionDate": "2026-11-16",
  "splitMode": "percent",
  "note": null,
  "ratesId": "<rateId>",
  "version": 1,
  "participants": [
    { "memberId": "<memberId>", "shareMinor": 9270, "percent": 50, "otherShareMinor": 60000, "status": "partly_paid" }
  ],
  "standing": { "involved": true, "openMinor": -4635, "settled": false },
  "appliedPayments": [
    { "paymentId": "<paymentId>", "fromId": "<memberId>", "toId": "<memberId>", "paidMinor": 3311, "paidCurrency": "USD", "coveredMinor": 4635, "method": "transfer", "date": "2026-11-17", "transactionDate": "2026-11-17" }
  ]
}
```

- **`ratesId`** names the entry in force on the expense's entry `date`, and is null when none existed.
- **`otherAmount`, `chargedCurrency` and `otherShareMinor`** are present only on a purchase charged in a different currency. `percent` is present only when `splitMode` is `percent`.
- **`status`** is `owes`, `partly_paid` or `paid`.
- **`appliedPayments`** includes credit applied to the expense, naming the payment the credit came from. `date` is the payment's entry date and `transactionDate` the day its money was given.

### `GET /api/payments`

Takes `limit` and `cursor` as above, and optionally `memberId` to list only the payments with one person. A `memberId` that is not a member returns `not_found`.

```json
{
  "revision": 42,
  "payments": [
    {
      "id": "<paymentId>",
      "fromId": "<memberId>",
      "toId": "<memberId>",
      "paid": { "amountMinor": 3963, "currency": "CAD" },
      "credited": { "amountMinor": 26550, "currency": "CLP" },
      "method": "transfer",
      "date": "2026-11-15",
      "transactionDate": "2026-11-15",
      "groupId": null,
      "version": 1
    }
  ],
  "nextCursor": null
}
```

### What each caller can see

- **Groups and expenses:** only the groups the caller belongs to, and the expenses in them.
- **Payments:** the whole payment only for its two parties, through `GET /api/payments`. Other members see just the part applied to expenses in their own groups, through `appliedPayments`.
- **Members:** every member, because anyone can be added to a group. Email addresses are never returned.

### Request bodies

| Route | Fields |
|---|---|
| `PUT /api/me/profile` | `homeCurrency`, `displayName` on the first call, and optionally `tone` |
| `POST /api/expenses` | `requestId`, `title`, `kind`, `groupId`, `payerId`, `amountMinor`, `currency`, `date`, `splitMode`, `participantIds`, and optionally `transactionDate`, `percents`, `otherAmount`, `chargedCurrency`, `note`, `usualSplit` |
| `PUT /api/expenses/{expenseId}` | The same fields except `date`, plus `version`. Without `transactionDate` the saved one is kept |
| `POST /api/payments` | `requestId`, `fromId`, `toId`, `paid`, `method`, `date`, and optionally `transactionDate`, `credited`, `groupId` |
| `PUT /api/payments/{paymentId}` | `requestId`, `transactionDate`, `version`. Nothing else about a payment can change |
| `POST /api/groups` | `requestId`, `name`, `memberIds`, and optionally `usualSplit` |
| `PUT /api/groups/{groupId}` | `requestId`, `name`, `memberIds`, `version`, and optionally `usualSplit` |
| `POST /api/exchange-rates` | `requestId`, `usdCad`, `cadClp`, `date` |

- **`usualSplit` on an expense** asks to make it the group's usual split, and holds a whole percentage for every current member of the group.
- **The debt currency** is `currency`. It must be one of the purchase's two currencies, and the form defaults it to `chargedCurrency`.
- **`credited`** is sent only when a payment clears the debt. It can be in any supported currency, and is accepted only within the tolerance in section 12 of the requirements. Otherwise the server credits exactly what was paid.
- **`paid.amountMinor`** can be at most 9007199254740991, the largest integer a browser reads exactly.
- **Either member of a payment can correct its `transactionDate`.** Anyone else gets `not_found`, as for a payment they cannot list. The money it moved stays where it is.
- **`participantIds` order is not significant.** The server stores participants in group order, because equal splits depend on it. A participant who has left the group keeps their position on the expense.

A write returns the saved resource, in the shape its read route uses: `GET /api/expenses/{expenseId}` for an expense, one entry of `payments` in `GET /api/payments` for a payment, and one entry of `groups` or `exchangeRates` in `GET /api/ledger` for a group or exchange rate. `PUT /api/me/profile` returns the `GET /api/me` shape. The frontend reloads the balances and the first page after every save, because one change can move many standings.

### Errors on these routes

| Situation | Code |
|---|---|
| A rule in section 7 of the requirements is broken, or a query parameter is not valid | `validation_error` |
| The caller did not add this expense or create this group, or has not finished the first-sign-in step | `forbidden` |
| The expense, payment, group or member does not exist or is not visible to the caller, including in a query parameter | `not_found` |
| A stale `version`, a reused `requestId` with different content, or a write that kept losing to others | `conflict` |
| A member with an open balance in the group cannot be removed from it | `member_has_open_balance` |
