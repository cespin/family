#!/usr/bin/env bash
#
# Builds the frontend and publishes it. A deploy never touches the live site: it uploads a staged
# build under stages/<hash>/, which you preview with /?setStage=<hash>, and --promote makes it live.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REPO_ROOT="$(cd "${WEB_DIR}/../.." && pwd)"
VAR_FILE="${REPO_ROOT}/backend/stacks/main.yaml"

# shellcheck source=../../../../../../backend/scripts/lib/aws-args.sh
source "${REPO_ROOT}/backend/scripts/lib/aws-args.sh"

usage() {
  cat <<USAGE
Usage: deploy.sh --profile <name> --region <region>                  Build and stage
       deploy.sh --promote <hash> --profile <name> --region <region> Make a stage live
       deploy.sh --list-stages --profile <name> --region <region>    List staged builds
USAGE
}

parse_aws_args "$@"
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"

MODE="stage"
PROMOTE_HASH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --promote)
      MODE="promote"
      PROMOTE_HASH="${2:-}"
      if [[ ! "$PROMOTE_HASH" =~ ^[0-9a-f]{7,40}$ ]]; then
        echo "error: --promote needs a stage hash" >&2
        exit 2
      fi
      shift 2
      ;;
    --list-stages) MODE="list"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

node "${REPO_ROOT}/scripts/check-aws-literals.mjs" --profile "$AWS_ARG_PROFILE"
apply_aws_args

PREFIX="$(stack_var export_key "$VAR_FILE")-$(stack_var stack_name "$VAR_FILE")"
require_export() {
  local value
  value="$(cfn_export "${PREFIX}-$1")"
  if [[ -z "$value" ]]; then
    echo "error: export ${PREFIX}-$1 is missing. Deploy the backend first." >&2
    exit 1
  fi
  printf '%s' "$value"
}

BUCKET="$(require_export WebappS3BucketName)"

# Copy first, prune last: index.html must never point at assets that are missing, so new files go
# up before it and old files are only removed after it. Only content-hashed files cache long-term.
publish_tree() {
  local source="${1%/}" target="${2%/}"
  aws s3 sync "${source}/assets" "${target}/assets" --only-show-errors \
    --cache-control 'public,max-age=31536000,immutable'
  aws s3 sync "$source" "$target" --exclude 'assets/*' --exclude index.html --only-show-errors \
    --cache-control 'public,max-age=60'
  aws s3 cp "${source}/index.html" "${target}/index.html" --only-show-errors \
    --cache-control 'public,max-age=60' --content-type 'text/html; charset=utf-8'
  aws s3 sync "$source" "$target" --delete --only-show-errors
}

case "$MODE" in
  list)
    aws s3 ls "s3://${BUCKET}/stages/" | awk '{print $2}' | tr -d '/'
    ;;
  stage)
    export VITE_COGNITO_DOMAIN VITE_COGNITO_CLIENT_ID
    VITE_COGNITO_DOMAIN="$(require_export CognitoDomain)"
    VITE_COGNITO_CLIENT_ID="$(require_export UserPoolClientId)"

    cd "$WEB_DIR"
    npm ci --no-audit --no-fund
    npm run lint
    npm run test
    npm run build

    if find dist -name '*.map' | grep -q .; then
      echo "error: the build contains source maps" >&2
      exit 1
    fi

    HASH="$(find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-12)"
    publish_tree dist/ "s3://${BUCKET}/stages/${HASH}/"
    echo "==> Staged ${HASH}"
    echo "    Preview: https://$(stack_var domain_name "$VAR_FILE")/?setStage=${HASH}"
    echo "    Clear:   https://$(stack_var domain_name "$VAR_FILE")/?setStage="
    ;;
  promote)
    if ! aws s3api head-object --bucket "$BUCKET" --key "stages/${PROMOTE_HASH}/index.html" >/dev/null 2>&1; then
      echo "error: stage ${PROMOTE_HASH} does not exist" >&2
      exit 1
    fi
    WORK_DIR="$(mktemp -d)"
    trap 'command rm -rf "$WORK_DIR"' EXIT
    aws s3 sync "s3://${BUCKET}/stages/${PROMOTE_HASH}/" "$WORK_DIR/" --only-show-errors
    publish_tree "${WORK_DIR}/" "s3://${BUCKET}/default/"
    aws cloudfront create-invalidation --distribution-id "$(require_export DistributionId)" \
      --paths '/*' --query 'Invalidation.Id' --output text
    echo "==> Promoted ${PROMOTE_HASH}"
    ;;
esac
