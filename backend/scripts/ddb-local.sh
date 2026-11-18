#!/usr/bin/env bash
#
# Runs DynamoDB Local for the integration tests. The table created here must stay identical to
# templates/data/stack.yaml. Requires java, curl, tar and the aws CLI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVTOOLS_DIR="${SCRIPT_DIR}/../.devtools"
DDB_DIR="${DEVTOOLS_DIR}/dynamodb-local"
PID_FILE="${DEVTOOLS_DIR}/dynamodb-local.pid"
PORT="${DDB_LOCAL_PORT:-8000}"
ENDPOINT="http://localhost:${PORT}"
TABLE_NAME="main-fa01-family"
TARBALL_URL="https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz"

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
  (cd "$DDB_DIR" && nohup java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar \
    -inMemory -port "$PORT" >"${DEVTOOLS_DIR}/dynamodb-local.log" 2>&1 & echo $! >"$PID_FILE")
  for _ in $(seq 1 30); do
    if ddb list-tables >/dev/null 2>&1; then create_table; return; fi
    sleep 1
  done
  echo "error: DynamoDB Local did not start" >&2
  exit 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) stop; start ;;
  *) echo "Usage: scripts/ddb-local.sh start|stop|reset" >&2; exit 2 ;;
esac
