#!/usr/bin/env bash
#
# Audits dependencies, builds every Lambda together, uploads the packages that changed, and records
# their content hashes in stacks/main.build.yaml, which deploy-vertical.sh passes to Sceptre.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FUNCTIONS_DIR="${BACKEND_DIR}/functions"
VAR_FILE="${BACKEND_DIR}/stacks/main.yaml"
BUILD_VAR_FILE="${BACKEND_DIR}/stacks/main.build.yaml"

# A crate missing from this list is never built into a deployable package.
FUNCTIONS=(
  health-get me-get auth-session auth-presignup
  ledger-read me-profile-put expenses-write payments-post groups-write exchange-rates-post
)

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  echo "Usage: scripts/build-functions.sh --profile <name> --region <region>"
}

parse_aws_args "$@"
if [[ ${#REMAINING_ARGS[@]} -gt 0 ]]; then
  echo "error: unknown argument: ${REMAINING_ARGS[0]}" >&2
  usage >&2
  exit 2
fi
apply_aws_args

BUCKET="$(cfn_export "$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")-ArtifactsBucketName")"
if [[ -z "$BUCKET" ]]; then
  echo "error: the artifacts bucket does not exist. Deploy the bootstrap vertical first." >&2
  exit 1
fi

"${SCRIPT_DIR}/audit-deps.sh"

echo "==> Building ${#FUNCTIONS[@]} functions"
(cd "$FUNCTIONS_DIR" && cargo lambda build --release --arm64 --output-format zip)

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
echo "# Written by scripts/build-functions.sh. Do not edit." > "$TMP_FILE"

for fn in "${FUNCTIONS[@]}"; do
  ZIP="${FUNCTIONS_DIR}/target/lambda/${fn}/bootstrap.zip"
  # Hashing the binary rather than the zip, whose timestamps differ on every build.
  HASH="$(unzip -p "$ZIP" bootstrap | shasum -a 256 | cut -c1-16)"
  KEY="lambda/${fn}/${HASH}/bootstrap.zip"
  if aws s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
    echo "==> ${fn}: unchanged (${HASH})"
  else
    echo "==> ${fn}: uploading (${HASH})"
    aws s3 cp "$ZIP" "s3://${BUCKET}/${KEY}" --only-show-errors
  fi
  echo "code_${fn//-/_}: '${HASH}'" >> "$TMP_FILE"
done

mv "$TMP_FILE" "$BUILD_VAR_FILE"
trap - EXIT
echo "==> Recorded package versions in stacks/main.build.yaml"
