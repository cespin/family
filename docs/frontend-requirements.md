# Frontend requirements: family expenses

What the Tres Monos web app needs from the backend, described by what family members must be able to see and do. **This is not an API contract.** Routes, payload shapes, key design and Lambda boundaries are for whoever implements the API to decide, following `docs/architecture.md` and `backend/docs/api-contract.md`.

## 1. Where things stand

The expense screens are connected to the expenses API described in `backend/docs/api-contract.md`. Under `npm run dev` they run on an in-memory stand-in for the API instead.

| File in `frontend/web/src/` | What it does |
|---|---|
| `lib/expenses.js` | The seam: one function per route, and the API's field names mapped to the screens' |
| `lib/expenses.sample.js` | The dev-only stand-in, answering in the API's shapes |
| `lib/sampleEngine.js` | The stand-in's balance engine. It is not the source of truth, and differs from section 12 in places |
| `lib/ledger.js` | Reads the API's standings and converts them to the currency on screen |
| `lib/money.js` and `lib/money.test.js` | Splits, parsing and conversion |

The frontend's internal data shape is not binding. It can adapt to the API, as long as the information and behaviour below are available.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Member** | An invited person who has signed in and chosen a home currency. Only members can pay for or share an expense |
| **Caller** | The signed-in member the app is showing the accounts for |
| **Home currency** | The currency a member thinks in. Every member has exactly one |
| **Group** | A set of members who share expenses, such as "Comidas familiares" |
| **Usual split** | The percentages a group normally divides expenses by. Optional |
| **Expense** | Something one member paid for, divided among participants |
| **Participant** | A member who carries a share of an expense. The payer may or may not be one |
| **Share** | The part of an expense a participant is responsible for |
| **Receipt amount** | What a purchase cost in the currency it was made in. Recorded separately only when the payer was charged in a different currency |
| **Charged amount** | What the payer was actually billed, such as on a credit card statement |
| **Debt currency** | The currency an expense's shares and debts are owed in |
| **Payment** | Money one member gave another to reduce what is owed. The screens also call this settling up |
| **Advance** | Money one member gives another ahead of future expenses. It is recorded as a payment, and what it does not pay off becomes credit |
| **Allocation** | How a payment is applied to specific open debts |
| **Open debt** | What is still unpaid on one expense between two members |
| **Balance** | The net of all open debts between the caller and one other member |

## 3. What family members must be able to do

### First sign-in

- Choose their home currency before entering the app.

### Settings

- Change their home currency at any time.

### Exchange rates

- See the current rates, when they were entered and by whom.
- Enter new rates.

### Home

- See a greeting, the total they are owed or owe, and one balance for each person.
- Narrow the balances and expenses to one group.
- View balances in CAD, USD or CLP, and see each person's balance in that person's home currency.
- See the exchange rates being used.
- Browse expenses newest first, filter them by kind, and see them grouped by month on wide screens.
- See on each expense who paid, when, the total, and what it means for them: they owe, they get money back, it is settled, or they are not part of it.

### Groups

- See every group they belong to, with its members, how many currencies it spans, and how it is usually split.
- See their own balance in each group, in their home currency.
- Create a group, giving it a name and choosing its members.
- Rename a group they created, and add or remove its members.

### Add or edit an expense

- Enter a title, amount, currency, kind, group, payer and participants, and optionally a note.
- Record a purchase charged in a different currency, such as a Canadian credit card used in Chile, by entering both the receipt amount and the charged amount.
- For those purchases, keep the debt in the charged currency, which is the default, or choose the receipt currency instead.
- Split equally, or by percentage in whole numbers.
- Choose "I pay all" or "I pay nothing", from the caller's side, not the payer's. Both are sent as an equal split: with only the caller as participant, or with everyone else. When someone else paid, "I pay all" makes the caller owe them the whole amount, so an advance the caller gave them covers it (section 12).
- Choose to keep a percentage split as the group's usual split.
- Edit an expense they added, through the same form.

### Expense detail

- See the title, kind, group, total, its value in their home currency at that date's rate, payer, date and note.
- See both amounts when a purchase was charged in a different currency, and each participant's share in both currencies.
- See what they still owe or are owed on this expense, and what has been paid so far.
- See each participant's share, percentage, home currency and status.
- See the activity on the expense: who added it and which payments were applied to it.

### Settle up

- See who they owe and who owes them, one person at a time.
- Record a payment in either direction, full or partial, in any supported currency, with the method used.
- Optionally choose which group the payment goes to.

### Record an advance

- Record an advance with any other active member, even when nothing is owed between them: who gave the money, the amount in any supported currency, and the method used.
- See before saving what it will do: it pays any debt the giver owes first, and the rest is credit that later debts draw on (section 12).
- It is sent as a payment with no group and no credited value, and needs no exchange rates to be saved.

## 4. Information the frontend needs

The backend sends data and stable codes. It never sends display text: all wording, number formats and date formats are produced by the frontend.

### The caller

Which member the signed-in account is. `GET /api/me` identifies the account today, but the allowlist stores only an email address, so the link from an account to a member profile does not exist yet. A person becomes a member when they first sign in and choose a home currency, so the frontend needs to know when the caller has not chosen one yet. Someone who has not finished this step cannot be chosen as a payer or participant.

### Members

Every member of the family, because anyone can be added to a group, including former members who appear in the history:

- A stable identifier.
- A display name, such as "Tío Beto".
- A home currency.
- Optionally, an avatar tone: `clay`, `honey`, `sage`, `lagoon` or `cocoa`. Without one, the frontend picks a colour from the name.

### Groups

Every group the caller belongs to:

- A stable identifier and a name.
- The member who created it.
- Its members, in a stable order. Equal splits depend on this order.
- Optionally, the usual split, with a whole percentage for **every** current member. A member left out of the split is stored as 0.

### Expenses

Every expense in the caller's groups, available page by page:

- A stable identifier and a title.
- A kind: `meal`, `parents`, `gift` or `other`.
- The group, the payer and the member who added it.
- The total and its currency. This is the debt currency, and the shares add up to this amount.
- Optionally, the purchase's other amount and currency, and which of the two is the charged amount.
- A calendar date, with no time and no time zone. 14 November stays 14 November for a reader in any country.
- The split mode: `equal` or `percent`.
- Each participant's share, and their percentage when the mode is `percent`.
- The exchange rates that applied on the expense's date.
- Optionally, a note.
- The payments applied to it, including payments between other participants.

Expenses on the same date need a stable order, such as when they were recorded.

### Payments

For each payment:

- A stable identifier, who paid and who received.
- What was actually paid, and in which currency.
- The value credited against the debt (see section 7).
- The method: `transfer`, `cash` or `other`.
- A calendar date.
- The group the person chose, if any.

For each expense a payment was applied to, the amount in the payment's currency and the amount it covered in the expense's currency. The detail screen shows both, as in "Diego paid USD 32,00 (≈ CLP 30.000)".

### Exchange rates

Family members enter the rates by hand. No outside rate service is used. The frontend needs:

- The current value of 1 USD in CAD and of 1 CAD in CLP. The rate between USD and CLP is derived from those two.
- The date they were entered, and who entered them.
- The rates in force on any past date, which are the latest ones entered on or before that date.

The latest rates stay in use however old they are, and the screens show their date. Until the first rates are entered there are none. Amounts that need converting show as absent (section 5), while expenses and payments that stay in one currency still work.

### Standings

The backend owns these figures (see section 6):

- **For each other member:** what is open between them and the caller, overall and per group, as signed amounts **in their original currencies**. The frontend needs the originals to convert to whichever currency the reader selects and to explain a balance, as in "your CLP 76.800, minus the CAD 75,00 they owe you".
- **For each expense:** what is still open for the caller, and whether it is settled for them.
- **For each participant on an expense:** whether they owe, have partly paid, or have paid off their share.

## 5. Money rules

- **Amounts are integers in minor units, always with their currency.** CAD and USD have 2 decimals and CLP has none.
- **The supported currencies are CAD, USD and CLP.**
- **Amounts in different currencies are never added without converting first.**
- **Round once, at the end.** Converted amounts are summed unrounded, then rounded. Group balances add up to the overall balance before rounding, so converted figures on screen can differ by one minor unit. The sample ledger shows this: its groups round to a sum of CAD 18,58 while the total is CAD 18,57.
- **A missing rate means a missing result.** If an amount cannot be converted, the result is absent, never zero and never a total of only the amounts that could be converted.

### Splits

| Mode | Rule |
|---|---|
| Equal | Divide and round down. Any remainder goes one minor unit at a time to the first participants, in group order |
| Percent | Whole percentages adding up to exactly 100 across participants. Round each share, and the largest share absorbs the difference |

Shares always add up to exactly the expense total. A share that rounds to zero creates no debt, so that participant has nothing to pay.

### Purchases charged in a different currency

A purchase can have two amounts. When a Canadian credit card is used in Chile, the receipt might say CLP 120.000 while the statement says CAD 185,40. The card company sets that rate, so the family's rates do not apply to it:

- **The app works out the purchase's rate from the two amounts**, here 1 CAD = 647,25 CLP. Nobody types a rate.
- **That rate applies only between those two currencies on that expense.** It never changes, and it does not replace the family's rates.
- **Every other conversion uses the family's rates**, including a third currency and any later payment.
- **Debts are owed in the charged currency by default.** The person entering the expense can choose the receipt currency instead.
- **Shares are split in the debt currency**, following the rules above. A share shown in the other currency is for reference only.

With that purchase split 50 · 25 · 25:

| Debt currency | Carlos | Lucía | Diego |
|---|---|---|---|
| CAD, the default | CAD 92,70 (≈ CLP 60.000) | CAD 46,35 (≈ CLP 30.000) | CAD 46,35 (≈ CLP 30.000) |
| CLP, if chosen | CLP 60.000 (≈ CAD 92,70) | CLP 30.000 (≈ CAD 46,35) | CLP 30.000 (≈ CAD 46,35) |

In CAD, the payer recovers exactly what the card charged, and a later payment in CLP follows the family's rate on that day. In CLP, the debt stays fixed in pesos, and the payer carries the exchange risk.

## 6. Balances and payment allocation

**The backend is the source of truth for balances and allocation.** The browser calculates them today only because no backend exists. They have to move to the server for two reasons:

- Every member must see the same facts. What Carlos sees he owes Lucía must mirror what Lucía sees Carlos owes her.
- Exchange rates change, and past payments must not change value when they do.

### Open debts

Between the caller and another member, each expense that is not settled creates at most one open debt:

- If the caller paid, the other member owes their share.
- If the other member paid, the caller owes their share.
- An expense paid by a third person creates no debt between these two.

Balances are between two people only. The app does not simplify debts across several people.

### Allocating a payment

Allocate when the payment is recorded, in this order:

1. **The chosen group first.** If the person chose a group, cover that group's debts, oldest expense first.
2. **Then the oldest debts in any group.** If no group was chosen, or money remains, cover the remaining debts oldest first.
3. **A group never absorbs more than its net debt.** Debts in opposite directions inside a group offset each other when working out how much it can take. Credit left over from an overpayment is not counted (section 12).
4. **Anything left over is credit.** It flips the balance in the payer's favour and belongs to the chosen group or, if none was chosen, to the group of the newest expense between the two members. Credit then pays later debts between the two members (section 12).

### When a debt counts as paid

A debt is closed when either of these is true:

- Its remaining amount reaches zero.
- The net of all debts between those two members in that group reaches zero.

Until a group's net reaches zero, offsetting does not change what an expense displays. An expense keeps showing the caller's full share, minus payments actually applied to it.

An expense is settled for the caller when all of the caller's open debts on it are closed. An expense the caller paid can stay open for other participants who have not paid.

### Rates and history

- **An allocation is final once recorded**, unless an edit re-applies it (see below). The conversion used when a payment is recorded is stored with it.
- **A closed debt stays closed.** A later rate change must not reopen it.
- **Open debts stay in their original currency.** Only the converted view moves as rates change.

### When an expense is edited

An edit can change what is owed after payments have been applied to it. When the amount, currency, payer, participants or group changes:

1. Recalculate the open debts between every pair of members the edit affects.
2. Re-apply all payments between each pair in their original order, following the allocation rules above and using each payment's stored conversion.

The payments themselves never change. If a share shrinks below what was paid, the excess moves to the next debt and then becomes credit. If a share grows, a settled expense reopens for the difference.

For example, Lucía corrects the Sunday lunch below from CLP 84.000 to CLP 40.000 after Carlos has paid CLP 10.000 towards it. Carlos's share falls from CLP 16.800 to CLP 8.000, so the lunch is settled and the extra CLP 2.000 reduces the Kinesiología from CLP 60.000 to CLP 58.000.

### Worked example

These figures come from `lib/expenses.sample.js`, with Carlos as the caller and rates of 1 USD = 1,40 CAD and 1 CAD = 670 CLP.

| Starting balance | Amount |
|---|---|
| Diego owes Carlos | CAD 75,00 (USD 53,57) |
| Carlos owes Lucía | CLP 26.550 (CAD 39,63) |
| Carlos owes Tío Beto | USD 12,00 (CAD 16,80) |
| **Carlos is owed in total** | **CAD 18,57** |

The debt to Lucía comes from two groups:

| Group | Expense | Date | Between Carlos and Lucía |
|---|---|---|---|
| Comidas familiares | Almuerzo familiar del domingo | 8 Nov | Carlos owes CLP 16.800 |
| Cuidado de Mamá y Papá | Tablet para las videollamadas | 12 Nov | Lucía owes CAD 75,00 (CLP 50.250) |
| Cuidado de Mamá y Papá | Kinesiología de Mamá | 14 Nov | Carlos owes CLP 60.000 |

Carlos's net debt to Lucía is CLP 16.800 in Comidas and CLP 9.750 in Cuidado. Use these scenarios as acceptance tests, each starting from the balances above:

| Carlos pays Lucía | Group chosen | Almuerzo | Kinesiología | Comidas balance | Cuidado balance |
|---|---|---|---|---|---|
| CLP 10.000 | None | CLP 6.800 left | CLP 60.000 left | Owes CAD 10,15 | Owed CAD 60,45 |
| CLP 10.000 | Cuidado | CLP 16.550 left | Settled | Owes CAD 24,70 | Owed CAD 75,00 |
| CLP 26.550 | None | Settled | Settled | Even | Owed CAD 75,00 |
| CLP 30.000 | None | Settled | Settled | Even | Owed CAD 80,15 |

In the last scenario Lucía ends up owing Carlos CLP 3.450, held in Cuidado. The tablet shows CAD 150,00 coming back to Carlos in the first scenario. In the other three it shows CAD 75,00, because Lucía's half is closed and only Diego's remains.

## 7. Saving data

Client-side checks are a convenience. The backend must enforce every rule below.

### Saving an expense

| Rule | Detail |
|---|---|
| Title | Required after trimming spaces, up to 40 characters |
| Note | Optional, up to 200 characters |
| Amount | A positive integer in minor units of a supported currency, up to CAD or USD 10.000,00 or CLP 10.000.000 |
| Second amount | Optional. A positive integer in minor units of a different supported currency, within the same maximum. The debt currency must be one of the two, and defaults to the charged amount's currency |
| Kind and split mode | One of the values in section 4 |
| Group | Must exist, and the caller must belong to it |
| Payer | Must be a member of the group |
| Participants | At least one, and all members of the group |
| Shares | Must add up to exactly the total and follow the rules in section 5 |
| Percentages | Required for `percent`, in whole numbers adding up to 100 |
| Date | A valid calendar date. The browser supplies it, because family members live in different time zones |
| Editing | Only the member who added the expense can edit it. Editing keeps the original date and who added it. An expense added by someone who has since left the group or lost access can no longer be edited |

When an expense is edited, a payer or participant who has since left the group may stay on it.

A percentage expense can also ask to become the group's usual split. That changes the split offered to everyone in the group.

### Recording a payment

| Rule | Detail |
|---|---|
| Parties | Two different members, and the caller must be one of them. Either side can record it |
| Amount paid | A positive integer in minor units of a supported currency, up to 9007199254740991. The expense maximum does not apply, because one payment can cover several expenses |
| Method | One of the values in section 4 |
| Group | Optional. When present, both parties must belong to it |
| Date | A valid calendar date supplied by the browser |

**Full payments in another currency.** Conversion rounding can leave a payment slightly off the exact debt. Paying CAD 39,63 against CLP 26.550 converts to CLP 26.552. When the payment is within one minor unit of the paying currency, the frontend treats the debt as cleared and sends two values: what was actually paid, and the debt's exact amount as the value credited. The backend must accept this only within that tolerance, and otherwise credit exactly what was paid.

### Choosing a home currency

A member sets only their own home currency, at first sign-in or at any time later, and it must be a supported currency. Changing it never changes what is owed, because debts stay in their original currencies.

### Creating a group

| Rule | Detail |
|---|---|
| Name | Required after trimming spaces, up to 40 characters |
| Members | At least two, including the caller, and all of them existing members |
| Usual split | Optional. Without one, the group splits equally |

### Changing a group

Only the member who created a group can rename it or change its members. The creator cannot be removed from the group. A group whose creator has lost access can no longer be changed.

Someone added to a group sees all of its past expenses, and owes nothing for expenses they did not take part in.

A member can be removed only when their balance with every other member of that group is zero. Once removed, they no longer see the group, and their past expenses stay in its history for everyone else. Removing a member also clears the group's usual split, because its percentages no longer add up to 100. The group splits equally until a new usual split is saved.

### Entering exchange rates

| Rule | Detail |
|---|---|
| Who | Any member |
| Values | Both rates are required, and each must be a positive number |
| Date | A valid calendar date supplied by the browser. An entry dated before the latest entry takes the latest entry's date |
| History | A new entry never replaces an earlier one, so past dates keep their rates |
| Effect | New rates change converted views and future payments. Payments already recorded keep their stored conversion |

## 8. Access, privacy and retention

- **Identity comes from the verified token.** A member identifier in a request never decides who the caller is.
- **Every route re-checks the allowlist**, as `GET /api/me` does, so removing someone takes effect immediately.
- **Members only reach the groups they belong to.** Expenses, balances and payments outside those groups must not be returned.
- **Responses must not be cached**, by browsers or by CloudFront.
- **Former members stay in the history.** Removing someone's access must not erase or rename their past expenses and payments.
- **Financial records never expire.** Expenses, payments, groups and exchange rates are kept indefinitely, and must not use the table's automatic expiry attribute, `expiresAt`.
- **Recovery relies on the table's existing point-in-time recovery.** No additional backups are required.

## 9. Behaviour the screens depend on

- **A failure is never an empty result.** A failed read must be an error. An empty list or a zero balance is read as a true statement about the family's money.
- **Reads reflect writes immediately.** The frontend reloads straight after every save, and the new data must be there.
- **Each response comes from one point in time.** Every response carries the ledger's revision. If a later page of expenses has a different revision from what is on screen, the frontend reloads from the first page.
- **Expenses load in pages, newest first.** Filtering by group and kind happens on the server, so a filter always finds every match. Balances must never depend on how many expenses have been loaded.
- **Retrying must not duplicate money.** If a save times out and the person tries again, the expense or payment must be recorded only once.
- **Concurrent edits are detected.** Saving over a change someone else just made must fail rather than silently overwrite it.

### Errors

The existing error codes in `backend/docs/api-contract.md` are already translated. The frontend keeps the form filled in when a save fails.

| Situation | Code |
|---|---|
| A rule in section 7 is broken | `validation_error` |
| The session has ended | `unauthorized` |
| The caller is not allowed to do this | `forbidden` |
| The expense or group does not exist or is not visible to the caller | `not_found` |
| Someone else changed the data first | `conflict` |
| A member with an open balance cannot be removed from a group | A new code, so the screen can explain the reason |

A new code needs a translation in `frontend/web/src/i18n/locales/es-VE/common.json`.

## 10. Not needed yet

The current screens have no use for these:

- Hiding an expense from a member. The design includes it, but it is planned for a later version.
- Deleting expenses or payments.
- Receipts, photos or attachments.
- Notifications or live updates.
- Debt simplification across several people.
- Exporting data.

## 11. Frontend changes made for the API

Done when the frontend connected to the API, and listed here so the reasons stay with them:

- Replace the three functions in `lib/expenses.js` with `apiFetch` calls, using `getToken()` from `useSession`.
- Remove the `expenses_unavailable` state.
- Load expenses page by page, and send the group and kind filters to the API instead of filtering in the browser.
- Show the Edit button only to the member who added the expense.
- Design and build the home currency step for a member's first sign-in, and a settings option to change it later.
- Design and build creating and changing groups, including the "Nuevo grupo" button left out of the first version. Only a group's creator sees the controls for changing it.
- Replace the browser's balance and allocation calculations in `lib/ledger.js` with the backend's standings.
- Send every member's percentage when saving a usual split. The form currently sends only the participants' percentages.
- Add the second amount and the debt currency choice to the expense form, and show both amounts on the expense detail.
- Add an optional note field to the expense form, and apply the title, note and amount limits in section 7.
- Leave the "Oculto para" badge unused until hiding is built.
- Replace the "Cambio de hoy" label with the date the rates were entered.
- Design and build the screen for entering exchange rates. It asks for confirmation when a new rate differs from the last one by more than 20%.
- Offer CAD, USD and CLP even when no rates exist. The currency choices are currently read from the rates.
- Keep `lib/expenses.sample.js` working for local development.
- Generate one `requestId` per save and reuse it when retrying, send back the `version` of an expense or group when changing it, and stop sending shares, which the server computes.

## 12. Resolved decisions

These close gaps found while designing the API. Where they differ from `lib/ledger.js`, this section wins. The data set in `backend/testdata/ledger` represents these rules, so change it together with them.

### Credit pays later debts

When a new expense creates a debt owed by the member who holds credit with the other person, the credit is applied to it straight away:

- **Order.** The oldest credit goes first, and credit held in the expense's own group goes before credit held in other groups.
- **Limit.** A group never absorbs more than its net debt, as with a payment.
- **Conversion.** Credit in another currency converts at the rates in force when the expense is recorded. If there are no rates, that credit stays unapplied.
- **Display.** The expense shows the amount as a payment applied to it, naming the original payment, so it can appear partly paid as soon as it is added.
- **Reverse payments.** A payment from the member who owes the credit reduces that credit first. Only what remains becomes credit in their favour.

Continuing the last scenario in section 6, where Lucía owes Carlos CLP 3.450 held in Cuidado: a new Comidas expense in which Carlos owes Lucía CLP 5.000 leaves CLP 1.550 open and no credit.

### How debts and payments are worked out

- **Events are replayed in the order they were recorded.** An expense entered later cannot capture a payment recorded before it, even with an older date. An edited expense keeps its original position.
- **Rates are read from the event.** Group nets and closed debts are worked out when an expense or payment is recorded, with the rates in force at that moment. Entering new rates never closes or reopens a debt.
- **A debt closes on a net of zero** when the group's net rounds to zero in the currency of the event being recorded.
- **Amounts stay whole.** Each allocation rounds what it covers to the debt's minor unit, using exact decimal arithmetic. Halves round away from zero, so both sides of a debt see the same figure.

### Full payments against mixed currencies

When a payment clears a balance held in several currencies, the frontend sends the debt's value as the credited value. The backend converts what was paid at the current rates, accepts the credited value only if it is within one minor unit of the paying currency, and otherwise credits exactly what was paid. The credited value can be in any supported currency, and it is the amount allocated to debts.

### Credit with no group

If two members share no expense and no group was chosen, the credit belongs to the two of them and to no group.

### Changing groups

- **Adding a member** stores 0 for them in the usual split, so its percentages still add up to 100.
- **An edit cannot change what a former group member owes or is owed on an expense**, because they can no longer see that group. Other corrections to the expense remain possible.

### Display names

A member's display name is set in the first sign-in step. The form starts from the name on their Google account, which may be missing.

### Sample data

In `lib/expenses.sample.js`, Diego's payment was USD 32,00, which converts to CLP 30.016: more than one minor unit away from the CLP 30.000 it covers. The rules above win, so the sample now records USD 31,98, as the backend's test data does.
