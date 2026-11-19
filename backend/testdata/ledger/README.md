# Ledger test data

A representative family ledger for testing the expenses API. It follows `backend/docs/dynamodb-schema.md`, and starts from the balances in the worked example in section 6 of `docs/frontend-requirements.md`.

All names and addresses are made up, and every address uses `example.test`.

## Files

| File | What it is |
|---|---|
| `items.jsonl` | The base data: one DynamoDB item per line, in typed JSON |
| `scenarios/<name>.jsonl` | Items to load on top of the base data for one situation |
| `expected.json` | What the API must return to each caller, for the base data and each scenario, and the requests behind each scenario's writes |
| `requests.json` | Requests to send against the base data, with the answer each must get |
| `COVERAGE.md` | Which data represents each requirement, and what data cannot represent |
| `dataset.mjs` | The source: the family's writes, in order, plus scenarios and request cases |
| `replay.mjs` | Reference model of the allocation rules, used to compute `expected.json` |
| `build.mjs` | Generates the files above and checks them |

`items.jsonl`, `scenarios/`, `expected.json`, `requests.json` and `COVERAGE.md` are generated. Change `dataset.mjs` instead of editing them.

## Load it into DynamoDB Local

From `backend/`:

```bash
scripts/ddb-local.sh reset
scripts/ddb-local.sh seed                    # the base data
scripts/ddb-local.sh seed payment-over       # the base data plus one scenario
```

`seed` only adds items, so run `reset` before switching scenario.

## Use it in tests

- **Tests against DynamoDB Local** run through `scripts/test-ddb-local.sh`. `cargo test --workspace` must stay hermetic, so they stay out of the default run.
- **Hermetic tests** in `functions/family-ledger/tests` load the same files into an in-memory table.
- **Each case in `requests.json` assumes freshly loaded base data**, because many of them change it.
- **Stored pair items must equal a full replay.** `items.jsonl` holds the correct `PAIR#` and `ALLOC#` items, so a test can run the API's writes and compare the results with them.
- **`expected.json` uses aliases** such as `carlos` and `care`. Its `ids` section maps each alias to the real identifier.
- **Each caller signs in as `<alias>@example.test`**, such as `carlos@example.test`.
- **A caller's `access`** is `forbidden` for `rosa`, who was removed from the allowlist, and for `nina`, who has not finished the first sign-in step.

## Change it

Follow the steps under "Test data set" in `backend/docs/dynamodb-schema.md`. Run this before committing:

```bash
node backend/testdata/ledger/build.mjs --check
```

The build stops if a published figure from the requirements no longer holds, so a failure there means the rules or the data are wrong. Do not change those figures to make it pass unless the requirements changed.
