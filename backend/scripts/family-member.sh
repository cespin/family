#!/usr/bin/env bash
#
# Manages the invite-only allowlist. Addresses live only in DynamoDB, never in this repository.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  cat <<USAGE
Usage: scripts/family-member.sh add <email> --profile <name> --region <region>
       scripts/family-member.sh remove <email> --profile <name> --region <region>
       scripts/family-member.sh list --profile <name> --region <region>
USAGE
}

parse_aws_args "$@"
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
COMMAND="${1:-}"
EMAIL="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"

case "$COMMAND" in
  add|remove)
    if [[ $# -ne 2 || "$EMAIL" != *@*.* ]]; then
      echo "error: ${COMMAND} needs one email address" >&2
      usage >&2
      exit 2
    fi
    ;;
  list)
    if [[ $# -ne 1 ]]; then usage >&2; exit 2; fi
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

apply_aws_args
TABLE="$(cfn_export "$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")-FamilyTableName")"
if [[ -z "$TABLE" ]]; then
  echo "error: the table does not exist. Deploy the data vertical first." >&2
  exit 1
fi

KEY="{\"PK\":{\"S\":\"MEMBER#${EMAIL}\"},\"SK\":{\"S\":\"PROFILE\"}}"
case "$COMMAND" in
  add)
    aws dynamodb put-item --table-name "$TABLE" --item \
      "{\"PK\":{\"S\":\"MEMBER#${EMAIL}\"},\"SK\":{\"S\":\"PROFILE\"},\"email\":{\"S\":\"${EMAIL}\"},\"addedAt\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}"
    echo "==> Invited ${EMAIL}"
    ;;
  remove)
    aws dynamodb delete-item --table-name "$TABLE" --key "$KEY"
    echo "==> Removed ${EMAIL}. Their access ends at the next token refresh."
    ;;
  list)
    aws dynamodb scan --table-name "$TABLE" \
      --filter-expression 'begins_with(PK, :prefix)' \
      --expression-attribute-values '{":prefix":{"S":"MEMBER#"}}' \
      --query 'Items[].email.S' --output text | tr '\t' '\n'
    ;;
esac
