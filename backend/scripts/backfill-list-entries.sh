#!/usr/bin/env bash
#
# Rewrites every expense's list entries that differ from the ones it writes today, such as entries
# saved before they carried the split and each participant's share. Entries that already match are
# left alone, so running it again changes nothing. It stops before writing if an expense has no
# live list entry. Deploy the api vertical first, so new writes already carry shares. See
# "Backfilling list entries" in docs/dynamodb-schema.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"
FUNCTIONS_DIR="${SCRIPT_DIR}/../functions"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  echo "Usage: scripts/backfill-list-entries.sh [--dry-run] --profile <name> --region <region>"
}

parse_aws_args "$@"
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
DRY_RUN=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=(--dry-run)
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

apply_aws_args
TABLE="$(cfn_export "$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")-FamilyTableName")"
if [[ -z "$TABLE" ]]; then
  echo "error: the table does not exist. Deploy the data vertical first." >&2
  exit 1
fi

echo "==> Backfilling list entries in ${TABLE}${DRY_RUN[*]+ (dry run)}"
cd "$FUNCTIONS_DIR"
cargo run --quiet -p family-ledger --features backfill --bin backfill-list-entries -- \
  --table "$TABLE" "${DRY_RUN[@]+"${DRY_RUN[@]}"}"
