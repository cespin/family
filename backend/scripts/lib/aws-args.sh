# Shared argument handling for every script that talks to AWS. Source it, then call
# parse_aws_args "$@". The AWS profile and region are mandatory arguments: this file deliberately
# never reads AWS_PROFILE, AWS_REGION or any other ambient default.
#
# Sets: AWS_ARG_PROFILE, AWS_ARG_REGION, AWS_ARG_CERTIFICATE_REGION, REMAINING_ARGS (array).
# Set REQUIRE_CERTIFICATE_REGION=1 before calling to make --certificate-region mandatory too.
# Define a usage() function before calling.

parse_aws_args() {
  AWS_ARG_PROFILE=""
  AWS_ARG_REGION=""
  AWS_ARG_CERTIFICATE_REGION=""
  REMAINING_ARGS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile|--region|--certificate-region)
        if [[ $# -lt 2 || "$2" == --* || -z "$2" ]]; then
          echo "error: $1 requires a value" >&2
          usage >&2
          exit 2
        fi
        case "$1" in
          --profile) AWS_ARG_PROFILE="$2" ;;
          --region) AWS_ARG_REGION="$2" ;;
          --certificate-region) AWS_ARG_CERTIFICATE_REGION="$2" ;;
        esac
        shift 2
        ;;
      *)
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done

  local missing=()
  [[ -n "$AWS_ARG_PROFILE" ]] || missing+=("--profile")
  [[ -n "$AWS_ARG_REGION" ]] || missing+=("--region")
  if [[ "${REQUIRE_CERTIFICATE_REGION:-0}" == "1" && -z "$AWS_ARG_CERTIFICATE_REGION" ]]; then
    missing+=("--certificate-region")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: missing required argument(s): ${missing[*]}" >&2
    usage >&2
    exit 2
  fi
}

# Make the validated values the only AWS configuration child processes can see. Static credentials
# in the environment would otherwise silently take priority over the profile.
apply_aws_args() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
  export AWS_PROFILE="$AWS_ARG_PROFILE"
  export AWS_DEFAULT_PROFILE="$AWS_ARG_PROFILE"
  export AWS_REGION="$AWS_ARG_REGION"
  export AWS_DEFAULT_REGION="$AWS_ARG_REGION"

  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  echo "==> AWS account ${AWS_ACCOUNT_ID}, profile ${AWS_ARG_PROFILE}, region ${AWS_ARG_REGION}"
}

# Prints a CloudFormation export's value, or nothing when it does not exist.
cfn_export() {
  aws cloudformation list-exports \
    --query "Exports[?Name=='$1'].Value | [0]" --output text | sed 's/^None$//'
}

# Prints a value from stacks/main.yaml. Only flat `key: value` lines are supported.
stack_var() {
  sed -n "s/^$1: *//p" "$2" | sed "s/^['\"]//; s/['\"]$//" | head -n 1
}
