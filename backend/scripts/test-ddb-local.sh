#!/usr/bin/env bash
#
# Runs the ledger's tests against DynamoDB Local: the storage adapter, the scenarios' writes and
# concurrent writes. They are kept out of `cargo test --workspace`, which must need nothing running.
# Requires java, curl, tar and the aws CLI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DDB_LOCAL_PORT="${DDB_LOCAL_PORT:-8011}"
export DDB_LOCAL_ENDPOINT="http://localhost:${DDB_LOCAL_PORT}"

"${SCRIPT_DIR}/ddb-local.sh" start
trap '"${SCRIPT_DIR}/ddb-local.sh" stop' EXIT

cd "${SCRIPT_DIR}/../functions"
# The workspace's clippy command skips this test target, so it is linted here.
cargo clippy -p family-ledger --features ddb-local-tests --all-targets -- -D warnings
cargo test -p family-ledger --features ddb-local-tests --test ddb_local
