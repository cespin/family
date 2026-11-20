#!/usr/bin/env bash
#
# Stores the Google OAuth web client in Parameter Store: the client ID as a String and the client
# secret as a SecureString, under /<stack_name>-<salt>/google-oauth/. The values are read from the
# terminal, never from arguments, and the secret is passed on stdin, so it does not reach shell
# history or the process list. The security vertical reads them at deploy time.
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

PARAM_PREFIX="/$(stack_var stack_name "$VAR_FILE")-$(stack_var salt "$VAR_FILE")/google-oauth"

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

# The client ID is not secret: it appears in every sign-in redirect.
aws ssm put-parameter --name "${PARAM_PREFIX}/client-id" --type String --value "$CLIENT_ID" \
  --overwrite --query Version --output text >/dev/null

# Passed on stdin through a file descriptor, so the secret is never a process argument.
NAME="${PARAM_PREFIX}/client-secret" CLIENT_SECRET="$CLIENT_SECRET" python3 -I -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "Name": os.environ["NAME"],
    "Value": os.environ["CLIENT_SECRET"],
    "Type": "SecureString",
    "Tier": "Standard",
    "Overwrite": True,
}))
' | aws ssm put-parameter --cli-input-json file:///dev/stdin --query Version --output text >/dev/null

echo "==> Google OAuth client stored. Deploy the security vertical to apply it."
