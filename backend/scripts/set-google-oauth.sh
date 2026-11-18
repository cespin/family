#!/usr/bin/env bash
#
# Stores the Google OAuth web client in Secrets Manager. The values are read from the terminal
# without echo, never from arguments, so they do not reach shell history or the process list.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  echo "Usage: scripts/set-google-oauth.sh --profile <name> --region <region>"
}

parse_aws_args "$@"
if [[ ${#REMAINING_ARGS[@]} -gt 0 ]]; then
  echo "error: unknown argument: ${REMAINING_ARGS[0]}" >&2
  usage >&2
  exit 2
fi
apply_aws_args

SECRET_ARN="$(cfn_export "$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")-GoogleOAuthSecretArn")"
if [[ -z "$SECRET_ARN" ]]; then
  echo "error: the secret does not exist. Deploy the bootstrap vertical first." >&2
  exit 1
fi

read -r -p "Google client ID: " CLIENT_ID
read -r -s -p "Google client secret: " CLIENT_SECRET
echo

if [[ "$CLIENT_ID" != *.apps.googleusercontent.com ]]; then
  echo "error: that does not look like a Google OAuth client ID" >&2
  exit 1
fi
if [[ -z "$CLIENT_SECRET" ]]; then
  echo "error: the client secret is empty" >&2
  exit 1
fi

# Passed on stdin through a file descriptor, so the secret is never a process argument.
CLIENT_ID="$CLIENT_ID" CLIENT_SECRET="$CLIENT_SECRET" python3 -I -c '
import json, os, sys
sys.stdout.write(json.dumps({"client_id": os.environ["CLIENT_ID"], "client_secret": os.environ["CLIENT_SECRET"]}))
' | aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" \
      --secret-string file:///dev/stdin --query VersionId --output text >/dev/null

echo "==> Google OAuth client stored. Deploy the security vertical to apply it."
