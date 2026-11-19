# DynamoDB schema

One table, `main-fa01-family`, with string keys `PK` and `SK`. The `expiresAt` attribute is the TTL.

| Entity | PK | SK | Attributes |
|---|---|---|---|
| Family member (allowlist) | `MEMBER#<lowercased email>` | `PROFILE` | `email`, `addedAt` |

New modules add their own `PK` prefix here.

## Family expenses

The behaviour comes from `docs/frontend-requirements.md`, and the routes are in `api-contract.md`.

The design needs no GSI and no change to the table definition in `templates/data/stack.yaml`.

### Access patterns

| Pattern | Used by | How |
|---|---|---|
| Resolve the caller to a member | Every expenses route | `GetItem` on `ACCOUNT#<email>` / `LINK` |
| Confirm the caller is still invited | Every expenses route | `GetItem` on the allowlist item, and a `ConditionCheck` in every write |
| Load balances, groups, members and rates | `GET /api/ledger`, every write | One strongly consistent `Query` per prefix on `LEDGER#main`: `GROUP#`, `PAIR#`, `PROFILE#` and `RATE#` |
| List a group's expenses, newest first | `GET /api/expenses` | `Query` on `GROUP#<groupId>#EXPENSES`, descending, plus the `PAIR#` prefix for what each expense means to the caller |
| List a group's expenses of one kind | `GET /api/expenses` | `Query` on `GROUP#<groupId>#KIND#<kind>`, descending |
| List expenses across the caller's groups | `GET /api/expenses` | One of the queries above per group, merged by sort key |
| Open one expense | `GET /api/expenses/{expenseId}` | `GetItem` on `EXPENSE#<id>`, then `BatchGetItem` on the `PAIR#` and `ALLOC#` items for its pairs and year |
| List the caller's payments | `GET /api/payments` | `Query` on `PAIR#<low>#<high>#PAYMENTS`, descending, for one person or merged across the caller's pairs |
| Find which members still have access | `GET /api/ledger`, group and expense writes | `BatchGetItem` on the allowlist items, using each member's private `email` |
| Replay a pair's history | Editing an expense, and audits | `Query` on the `EXPENSE#` and `PAYMENT#` prefixes |

**No route uses a filter expression.** Every list reads a partition built for that question.

**Why the indexes are items.** The screens reload straight after a save and must see it. GSIs are eventually consistent, and an LSI can only be created with the table. Index items live in the base table, are read with strong consistency, and are written in the same transaction as the expense.

### Items

| Entity | PK | SK | Attributes |
|---|---|---|---|
| Account link | `ACCOUNT#<lowercased email>` | `LINK` | `memberId` |
| Ledger head | `LEDGER#main` | `HEAD` | `rev`, `lastWrite` |
| Member | `LEDGER#main` | `PROFILE#<memberId>` | `displayName`, `homeCurrency`, `tone`, `email`, `createdAt` |
| Group | `LEDGER#main` | `GROUP#<groupId>` | `name`, `createdBy`, `memberIds`, `usualSplit`, `version`, `seq` |
| Expense | `LEDGER#main` | `EXPENSE#<expenseId>` | See below |
| Payment | `LEDGER#main` | `PAYMENT#<paymentId>` | See below |
| Exchange rate | `LEDGER#main` | `RATE#<rateId>` | `usdCad`, `cadClp`, `date`, `enteredBy`, `seq` |
| Pair state | `LEDGER#main` | `PAIR#<lowMemberId>#<highMemberId>` | `balances`, `openDebts`, `credits`, `newestDebt` |
| Pair allocations | `LEDGER#main` | `ALLOC#<lowMemberId>#<highMemberId>#<year>` | `allocations` |
| Group expense entry | `GROUP#<groupId>#EXPENSES` | `<date>#<seq>` | See below |
| Group kind entry | `GROUP#<groupId>#KIND#<kind>` | `<date>#<seq>` | See below |
| Pair payment entry | `PAIR#<lowMemberId>#<highMemberId>#PAYMENTS` | `<date>#<seq>` | See below |

Every `LEDGER#main` item except the head also carries `rev`, the revision of its latest write. Items saved with a `requestId` carry `lastRequestId` and `lastRequestHash`, the SHA-256 in hexadecimal of the request body with sorted keys and no whitespace.

**Expense:** `title`, `kind`, `groupId`, `payerId`, `addedBy`, `amountMinor`, `currency`, `otherAmountMinor`, `otherCurrency`, `chargedCurrency`, `date`, `splitMode`, `participantIds`, `shares`, `percents`, `note`, `recordedRates`, `recordedAt`, `version`, `seq`.

**Payment:** `fromId`, `toId`, `paidMinor`, `paidCurrency`, `creditedMinor`, `creditedCurrency`, `method`, `date`, `groupId`, `recordedRates`, `recordedBy`, `recordedAt`, `seq`. The credited value is what the replay allocates. It equals the paid value unless a full payment was accepted within tolerance.

**Group expense entry:** `expenseId`, `title`, `kind`, `groupId`, `payerId`, `addedBy`, `amountMinor`, `currency`, `date`, `participantIds`, `seq`, `rev`.

**Group kind entry:** `expenseId`, `title`, `kind`, `groupId`, `payerId`, `addedBy`, `amountMinor`, `currency`, `date`, `participantIds`, `seq`, `rev`.

**Pair payment entry:** `paymentId`, `fromId`, `toId`, `paidMinor`, `paidCurrency`, `creditedMinor`, `creditedCurrency`, `method`, `date`, `groupId`, `seq`, `rev`.

- **`seq`** is the head revision that created the item. It never changes, so an edited expense keeps its place in the replay. In a sort key it is zero-padded to eight digits, as in `2026-11-14#00000017`.
- **`version`** counts the changes to an expense or group, for detecting concurrent edits.
- **`memberIds` and `participantIds` are ordered.** Equal splits depend on the order, and an expense keeps its own copy so a participant who left the group still has a position.
- **`recordedRates`** holds the `usdCad` and `cadClp` in force when the item was recorded, or is absent if no rates existed.
- **Rates are decimal strings**, compared and multiplied with decimal arithmetic. Floats never touch money.
- **`email` on a member is private.** It locates the allowlist item and is never returned by a route.
- **The account link has its own prefix** so `family-member.sh list`, which scans `MEMBER#`, does not report removed people as invited. What the link means is in `docs/auth/architecture.md`.
- **Nothing in the ledger is ever deleted or carries `expiresAt`**, as section 8 of the requirements requires.
- **A worked-out item that no longer applies is retired, not deleted.** When an edit moves an expense to another group or kind, its old list entries are overwritten with `removed: true` and the new `rev`, and readers skip them. A delete would leave nothing for the read protocol to detect, so a read caught mid-write could silently miss the expense.

### Balances are stored per pair

Each pair of members has one state item. Amounts in it are signed from the point of view of the lower member identifier: positive means the other member owes.

- **`balances`** holds the open amount per group and currency. An entry with no `groupId` is credit that belongs to no group.
- **`openDebts`** holds each debt that is not closed: `expenseId`, `groupId`, `date`, `seq`, `currency`, `grossMinor` and `remainingMinor`. A closed debt leaves the list, so the item's size follows what is unpaid rather than the length of the history.
- **`credits`** holds unused credit: `paymentId`, `seq`, `amountMinor`, `currency`, `groupId` and `appliedTotal`. `appliedTotal` is the exact amount of the payment that has reached debts so far, in the credited currency, written as a fraction such as `141169/50`. `amountMinor` is rounded, so a later slice needs this value to work out its share of what was really paid.
- **`newestDebt`** holds the `date`, `seq` and `groupId` of the newest expense between the two, closed or not, because leftover credit can belong to its group.

Each allocation item holds what payments covered on expenses dated in that year: `paymentId`, `expenseId`, `fromId`, `toId`, `paidMinor`, `paidCurrency`, `coveredMinor`, `method` and `date`. An expense's date never changes, so its detail screen reads exactly one allocation item per pair.

**Adding an expense or recording a payment** applies the rules in sections 6 and 12 of the requirements to the pair state alone, without reading the history.

**Editing an expense** is the only normal operation that reads the history. It replays every expense and payment of each affected pair in `seq` order, using the `recordedRates` on each event, then rewrites those pairs' state and allocation items.

- **Entering rates changes no debt**, because the state only changes when an expense or payment is recorded.
- **Replay is the definition of the correct state.** Stored pair items must always equal the result of a full replay, and tests must assert it.
- **The rules must stay stable.** Changing them means rebuilding every pair item by replay, so treat it as a data migration. The scenarios in sections 6 and 12 of the requirements are required tests.

### Write protocol

1. Confirm the caller is invited and is a member. Then, if the item already carries this `requestId`, answer from it: the same request hash from the same member returns the saved result, and anything else is `conflict`. This check runs before the remaining ones, so a retried save that already landed never reports a conflict.
2. Run the read protocol to load the balances, groups, members and rates. An edit also replays the affected pairs.
3. Validate against the loaded state, including `version` on an edit.
4. Send one `TransactWriteItems` with the changed items, a `ConditionCheck` that the caller's allowlist item exists, and an update of the head conditioned on the `rev` read in step 2. It stamps the new `rev` on each changed item except the account link, and lists their keys in `lastWrite`.
5. If the transaction was cancelled only by the head condition or by a `TransactionConflict`, repeat from step 1, up to three times. After that, answer `conflict`.

**The head is created by the first write.** A table with no head item is at revision 0, so that write is conditioned on the head not existing.

| Write | Items in the transaction |
|---|---|
| Add an expense | The head, the expense, two list entries, one pair state per other participant, and any allocation items credit touches |
| Record a payment | The head, the payment, its list entry, one pair state, and one allocation item per year it covers |
| Edit an expense | The head, the expense, its list entries, and the state and allocation items of each affected pair |
| Save a usual split through an expense | The items above, plus the group, whose `version` increases |
| Finish the first sign-in step | The head, the member and the account link |

**The first sign-in step creates the account link with `attribute_not_exists(PK)`.** If two requests race, the loser re-reads the link and treats the request as a change of home currency, so one person can never become two members.

Do not use the `TransactWriteItems` client token as the retry guarantee, because it is valid for only 10 minutes.

### Read protocol

AWS documents `Query` as read-committed against transactions, so a read can see part of a write that is still in flight. Comparing the head before and after is not enough on its own.

1. `GetItem` the head, strongly consistent.
2. Run the route's queries, strongly consistent, across every page they need.
3. `GetItem` the head again.
4. Read any key in `lastWrite` that step 2 did not return, with a strongly consistent `BatchGetItem`.
5. Accept the result only if both heads have the same `rev`, no item has a higher `rev`, and every key in `lastWrite` carries that `rev`.
6. Otherwise repeat, up to three times, then fail with `internal_error`. A failed read is never returned as partial data.

`family-ledger/tests/protocols.rs` interleaves writes with each step of this protocol. DynamoDB Local cannot produce a partly visible transaction on demand, so that part is proven only against the in-memory table.

### Test data set

`testdata/ledger` holds a representative ledger that loads into DynamoDB Local with `scripts/ddb-local.sh seed`. It comes with the results the API must produce and the requests it must refuse. See its `README.md`.

**Keep it in step with this document.** Any change to the keys, items or attributes above, or to the rules in sections 5, 6, 7 or 12 of the requirements, must update `testdata/ledger/dataset.mjs` in the same change:

1. Change the story in `dataset.mjs`, and `replay.mjs` if a rule changed.
2. Add a new case to `COVERAGE` and, when a figure can be stated by hand, to `SCENARIOS`.
3. Run `node backend/testdata/ledger/build.mjs` to regenerate the files, and commit them.

`node backend/testdata/ledger/build.mjs --check` fails when the attributes listed in this document and those in the data set differ, or when the generated files are out of date.

### Limits

| Limit | Effect here |
|---|---|
| 400 KB per item | A pair's state holds about 2,500 unpaid debts, at about 160 bytes each, and shrinks as they are paid. If a pair ever approaches that, move to one item per open debt. An allocation item holds about 1,500 allocations per pair per year |
| 100 actions per transaction | An edit is the largest write: one state item and one allocation item per year for each affected pair. Changing the payer among six members affects up to nine pairs, which reaches the limit at about nine years of allocations |
| 1 MB per `Query` page | Lists read one page of results at a time, and `GET /api/ledger` reads across pages |
| Reading the history | Only an edit does this, so its cost grows with the ledger. Other routes read a fixed set of small items |
