#!/usr/bin/env bash
#
# Stores the Google OAuth web client in Parameter Store: the client ID as a String and the client
# secret as a SecureString, under /<stack_name>-<salt>/google-oauth/. The values are read from the
# terminal, never from arguments, and the secret is never a process argument, so it does not reach
# shell history or the process list. The security vertical reads them at deploy time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAR_FILE="${SCRIPT_DIR}/../stacks/main.yaml"
PYTHON="${SCRIPT_DIR}/../.venv/bin/python"

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
[[ -x "$PYTHON" ]] || {
  echo "error: the backend venv is missing. Run: cd backend && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -r requirements.txt" >&2
  exit 1
}
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

# Written with boto3 from the backend venv (it ships with Sceptre). The AWS CLI cannot read
# --cli-input-json from a pipe, so the secret would otherwise need an argument or a temp file. Here it
# travels in this process's environment only. The client ID is not secret: it appears in every
# sign-in redirect.
PARAM_PREFIX="$PARAM_PREFIX" CLIENT_ID="$CLIENT_ID" CLIENT_SECRET="$CLIENT_SECRET" \
  "$PYTHON" -I -c '
import os, sys
import boto3
ssm = boto3.Session(profile_name=sys.argv[1], region_name=sys.argv[2]).client("ssm")
prefix = os.environ["PARAM_PREFIX"]
ssm.put_parameter(Name=prefix + "/client-id", Value=os.environ["CLIENT_ID"],
                  Type="String", Tier="Standard", Overwrite=True)
ssm.put_parameter(Name=prefix + "/client-secret", Value=os.environ["CLIENT_SECRET"],
                  Type="SecureString", Tier="Standard", Overwrite=True)
' "$AWS_ARG_PROFILE" "$AWS_ARG_REGION"

echo "==> Google OAuth client stored. Deploy the security vertical to apply it."
