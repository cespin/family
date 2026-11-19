#!/usr/bin/env bash
#
# Runs DynamoDB Local for the integration tests. The table created here must stay identical to
# templates/data/stack.yaml. Requires java, curl, tar and the aws CLI.
#
# `seed` loads the test data set in testdata/ledger, optionally with one of its scenarios on top.
# It only adds items, so run `reset` first to start from an empty table.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVTOOLS_DIR="${SCRIPT_DIR}/../.devtools"
DDB_DIR="${DEVTOOLS_DIR}/dynamodb-local"
PID_FILE="${DEVTOOLS_DIR}/dynamodb-local.pid"
PORT="${DDB_LOCAL_PORT:-8000}"
ENDPOINT="http://localhost:${PORT}"
TABLE_NAME="main-fa01-family"
TARBALL_URL="https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz"
DATA_DIR="${SCRIPT_DIR}/../testdata/ledger"
BATCH_SIZE=25

# DynamoDB Local accepts any credentials and any region name, so nothing here is a real AWS value.
export AWS_ACCESS_KEY_ID=fake AWS_SECRET_ACCESS_KEY=fake
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
ddb() { aws dynamodb --endpoint-url "$ENDPOINT" --region local "$@"; }

create_table() {
  ddb create-table --table-name "$TABLE_NAME" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE >/dev/null
  echo "==> Created ${TABLE_NAME}"
}

start() {
  mkdir -p "$DDB_DIR"
  if [[ ! -f "${DDB_DIR}/DynamoDBLocal.jar" ]]; then
    echo "==> Downloading DynamoDB Local"
    curl -fsSL "$TARBALL_URL" | tar -xz -C "$DDB_DIR"
  fi
  # exec makes the recorded PID the java process itself, so that stop really stops it.
  (cd "$DDB_DIR" && exec nohup java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar \
    -inMemory -port "$PORT" >"${DEVTOOLS_DIR}/dynamodb-local.log" 2>&1 </dev/null) &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 30); do
    if ddb list-tables >/dev/null 2>&1; then create_table; return; fi
    sleep 1
  done
  echo "error: DynamoDB Local did not start" >&2
  exit 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    # reset starts again on the same port, so wait until this process has let go of it.
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    rm -f "$PID_FILE"
  fi
}

write_batch() {
  local request="${DEVTOOLS_DIR}/seed-batch.json" unprocessed
  printf '{"%s":[%s]}' "$TABLE_NAME" "$1" >"$request"
  unprocessed="$(ddb batch-write-item --request-items "file://${request}" \
    --query 'length(UnprocessedItems)' --output text)"
  rm -f "$request"
  if [[ "$unprocessed" != "0" ]]; then
    echo "error: DynamoDB Local did not accept every item" >&2
    exit 1
  fi
}

# Each line of the file is one item in DynamoDB's typed JSON.
put_items() {
  local file="$1" batch="" count=0 total=0 line
  while IFS= read -r line || [[ -n "$line" ]]; do
    batch+="${batch:+,}{\"PutRequest\":{\"Item\":${line}}}"
    count=$((count + 1))
    total=$((total + 1))
    if ((count == BATCH_SIZE)); then
      write_batch "$batch"
      batch=""
      count=0
    fi
  done <"$file"
  if ((count > 0)); then write_batch "$batch"; fi
  echo "==> Loaded ${total} items from $(basename "$file")"
}

seed() {
  local scenario="${1:-}" overlay="${DATA_DIR}/scenarios/${1:-}.jsonl"
  if [[ -n "$scenario" && ! -f "$overlay" ]]; then
    echo "error: no scenario named ${scenario} in testdata/ledger/scenarios" >&2
    exit 2
  fi
  put_items "${DATA_DIR}/items.jsonl"
  if [[ -n "$scenario" ]]; then put_items "$overlay"; fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) stop; start ;;
  seed) seed "${2:-}" ;;
  *) echo "Usage: scripts/ddb-local.sh start|stop|reset|seed [scenario]" >&2; exit 2 ;;
esac
