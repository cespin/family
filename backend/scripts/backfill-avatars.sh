#!/usr/bin/env bash
#
# Gives a monkey avatar to every member saved before avatars existed, in the order they signed up.
# Members who already have an avatar keep it, so running it again changes nothing. Deploy the api
# vertical first, so the first sign-in step already stores one. See "Backfilling avatars" in
# docs/dynamodb-schema.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"
FUNCTIONS_DIR="${SCRIPT_DIR}/../functions"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  echo "Usage: scripts/backfill-avatars.sh [--dry-run] --profile <name> --region <region>"
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

echo "==> Backfilling avatars in ${TABLE}${DRY_RUN[*]+ (dry run)}"
cd "$FUNCTIONS_DIR"
cargo run --quiet -p family-ledger --features backfill --bin backfill-avatars -- \
  --table "$TABLE" "${DRY_RUN[@]+"${DRY_RUN[@]}"}"
