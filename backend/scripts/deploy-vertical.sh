#!/usr/bin/env bash
#
# The only supported way to deploy a backend vertical.
#
# First-time order:
#   bootstrap -> (set-google-oauth.sh) -> certificate -> data -> (build-functions.sh)
#   -> security -> api -> hosting
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
VAR_FILE="${BACKEND_DIR}/stacks/main.yaml"
BUILD_VAR_FILE="${BACKEND_DIR}/stacks/main.build.yaml"
SCEPTRE="${BACKEND_DIR}/.venv/bin/sceptre"
VERTICALS="bootstrap certificate data security api hosting"

# shellcheck source=lib/aws-args.sh
source "${SCRIPT_DIR}/lib/aws-args.sh"

usage() {
  cat <<USAGE
Usage: scripts/deploy-vertical.sh <vertical> --profile <name> --region <region> \\
         --certificate-region <region> [--yes]

Verticals: ${VERTICALS}

  --profile             AWS profile to deploy with (required)
  --region              AWS region for the application stacks (required)
  --certificate-region  AWS region CloudFront reads its certificate from (required)
  --yes                 Skip the confirmation prompt
  --unprotected         security only: launch without deletion protection. Use it for the very
                        first launch, so a failed create can roll back, then deploy again without it
USAGE
}

REQUIRE_CERTIFICATE_REGION=1
parse_aws_args "$@"

VERTICAL=""
ASSUME_YES=0
UNPROTECTED=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --unprotected) UNPROTECTED=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "error: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$VERTICAL" ]]; then
        echo "error: only one vertical can be deployed at a time" >&2
        exit 2
      fi
      VERTICAL="$arg"
      ;;
  esac
done

if [[ " ${VERTICALS} " != *" ${VERTICAL} "* || -z "$VERTICAL" ]]; then
  echo "error: expected a vertical, one of: ${VERTICALS}" >&2
  usage >&2
  exit 2
fi

if [[ "$UNPROTECTED" == "1" && "$VERTICAL" != "security" ]]; then
  echo "error: --unprotected only applies to the security vertical" >&2
  exit 2
fi

[[ -x "$SCEPTRE" ]] || {
  echo "error: Sceptre is not installed. Run: cd backend && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -r requirements.txt" >&2
  exit 1
}

node "${REPO_ROOT}/scripts/check-aws-literals.mjs" --profile "$AWS_ARG_PROFILE"
apply_aws_args

EXPORT_KEY="$(stack_var export_key "$VAR_FILE")"
STACK_NAME="$(stack_var stack_name "$VAR_FILE")"
APEX_DOMAIN="$(stack_var apex_domain_name "$VAR_FILE")"
SALT="$(stack_var salt "$VAR_FILE")"
PREFIX="${EXPORT_KEY}-${STACK_NAME}"

require_export() {
  local value
  value="$(cfn_export "${PREFIX}-$1")"
  if [[ -z "$value" ]]; then
    echo "error: export ${PREFIX}-$1 is missing. Deploy the $2 vertical first." >&2
    exit 1
  fi
  printf '%s' "$value"
}

SCEPTRE_ARGS=(
  --var-file "$VAR_FILE"
  --var "profile=${AWS_ARG_PROFILE}"
  --var "region=${AWS_ARG_REGION}"
  --var "certificate_region=${AWS_ARG_CERTIFICATE_REGION}"
)

add_build_vars() {
  if [[ ! -f "$BUILD_VAR_FILE" ]]; then
    echo "error: ${BUILD_VAR_FILE} is missing. Run scripts/build-functions.sh first." >&2
    exit 1
  fi
  SCEPTRE_ARGS+=(--var-file "$BUILD_VAR_FILE")
}

add_template_bucket() {
  SCEPTRE_ARGS+=(--var "template_bucket_name=$(require_export ArtifactsBucketName bootstrap)")
}

add_hosted_zone() {
  local zone_id
  zone_id="$(aws route53 list-hosted-zones-by-name --dns-name "$APEX_DOMAIN" --max-items 1 \
    --query "HostedZones[?Name=='${APEX_DOMAIN}.'] | [0].Id" --output text)"
  if [[ -z "$zone_id" || "$zone_id" == "None" ]]; then
    echo "error: no Route 53 hosted zone found for ${APEX_DOMAIN}" >&2
    exit 1
  fi
  SCEPTRE_ARGS+=(--var "hosted_zone_id=${zone_id##*/}")
}

case "$VERTICAL" in
  certificate)
    add_hosted_zone
    ;;
  security)
    require_export FamilyTableArn data >/dev/null
    add_build_vars
    SECRET_ARN="$(require_export GoogleOAuthSecretArn bootstrap)"
    VERSION_ID="$(aws secretsmanager list-secret-version-ids --secret-id "$SECRET_ARN" \
      --query "Versions[?contains(VersionStages, 'AWSCURRENT')] | [0].VersionId" --output text)"
    if [[ -z "$VERSION_ID" || "$VERSION_ID" == "None" ]]; then
      echo "error: the Google OAuth secret has no value. Run scripts/set-google-oauth.sh first." >&2
      exit 1
    fi
    SCEPTRE_ARGS+=(--var "google_secret_version_id=${VERSION_ID}")
    if [[ "$UNPROTECTED" == "1" ]]; then
      SCEPTRE_ARGS+=(--var "deletion_protected=false")
    fi

    # A taken prefix would otherwise roll the whole stack back after the pool is created.
    DOMAIN_PREFIX="$(stack_var cognito_domain_prefix "$VAR_FILE")"
    DOMAIN_OWNER="$(aws cognito-idp describe-user-pool-domain --domain "$DOMAIN_PREFIX" \
      --query 'DomainDescription.UserPoolId' --output text)"
    if [[ -n "$DOMAIN_OWNER" && "$DOMAIN_OWNER" != "None" ]]; then
      CURRENT_POOL="$(aws cloudformation describe-stacks \
        --stack-name "${STACK_NAME}-$(stack_var app_name "$VAR_FILE")-security" \
        --query "Stacks[0].Outputs[?OutputKey=='UserPoolArn'].OutputValue | [0]" \
        --output text 2>/dev/null || true)"
      if [[ "$CURRENT_POOL" != *"/${DOMAIN_OWNER}" ]]; then
        echo "error: the Cognito domain prefix '${DOMAIN_PREFIX}' is already in use." >&2
        exit 1
      fi
    fi
    ;;
  api)
    require_export FamilyTableArn data >/dev/null
    require_export UserPoolArn security >/dev/null
    add_build_vars
    add_template_bucket
    ;;
  hosting)
    require_export RestApiId api >/dev/null
    add_hosted_zone
    add_template_bucket
    ;;
esac

cd "$BACKEND_DIR"
if [[ "$ASSUME_YES" == "1" ]]; then
  "$SCEPTRE" "${SCEPTRE_ARGS[@]}" launch --yes "$VERTICAL"
else
  "$SCEPTRE" "${SCEPTRE_ARGS[@]}" launch "$VERTICAL"
fi

if [[ "$VERTICAL" == "api" ]]; then
  REST_API_ID="$(require_export RestApiId api)"
  echo "==> Publishing the API to stage ${STACK_NAME}"
  aws apigateway create-deployment --rest-api-id "$REST_API_ID" --stage-name "$STACK_NAME" \
    --description "deploy-vertical.sh" --query id --output text
  aws apigateway update-stage --rest-api-id "$REST_API_ID" --stage-name "$STACK_NAME" \
    --patch-operations \
      'op=replace,path=/*/*/throttling/rateLimit,value=10' \
      'op=replace,path=/*/*/throttling/burstLimit,value=20' \
    --query stageName --output text
fi

echo "==> ${VERTICAL} deployed (salt ${SALT})"
