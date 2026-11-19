#!/usr/bin/env bash
#
# One-time backfill: gives every expense and payment saved before transaction dates existed the
# transaction date passed in --date, and moves their list entries to it. Items that already have
# one are left alone, so running it again changes nothing. Deploy the api vertical first, because
# the Lambdas before it cannot read the moved entries. See "Backfilling transaction dates" in
# docs/dynamodb-schema.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"
FUNCTIONS_DIR="${SCRIPT_DIR}/../functions"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  echo "Usage: scripts/backfill-transaction-date.sh --date <YYYY-MM-DD> [--dry-run] --profile <name> --region <region>"
}

parse_aws_args "$@"
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
DATE=""
DRY_RUN=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)
      if [[ $# -lt 2 ]]; then usage >&2; exit 2; fi
      DATE="$2"
      shift 2
      ;;
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
if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "error: --date needs a day as YYYY-MM-DD" >&2
  usage >&2
  exit 2
fi

apply_aws_args
TABLE="$(cfn_export "$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")-FamilyTableName")"
if [[ -z "$TABLE" ]]; then
  echo "error: the table does not exist. Deploy the data vertical first." >&2
  exit 1
fi

echo "==> Backfilling transaction dates in ${TABLE} with ${DATE}${DRY_RUN[*]+ (dry run)}"
cd "$FUNCTIONS_DIR"
cargo run --quiet -p family-ledger --features backfill --bin backfill-transaction-date -- \
  --table "$TABLE" --date "$DATE" "${DRY_RUN[@]+"${DRY_RUN[@]}"}"
