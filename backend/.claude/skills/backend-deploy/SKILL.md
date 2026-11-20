---
name: backend-deploy
description: Deploy the family dashboard backend. Use when deploying, redeploying or troubleshooting a Sceptre vertical, building Lambda packages, storing the Google OAuth client, or managing the invite-only family allowlist.
---

# Backend deploy

Run everything from `backend/`. Use the AWS profile available in the runtime and pass every value explicitly. Scripts refuse to run without them.

```bash
ARGS=(--profile "$AWS_PROFILE" --region <region> --certificate-region <certificate-region>)
```

## Order

| Step | Command | Needed when |
|---|---|---|
| 1 | `scripts/deploy-vertical.sh bootstrap "${ARGS[@]}"` | First deploy |
| 2 | `scripts/set-google-oauth.sh --profile "$AWS_PROFILE" --region <region>` | First deploy, or rotating the client. Any time before `security`. Interactive, so the owner runs it |
| 3 | `scripts/deploy-vertical.sh certificate "${ARGS[@]}"` | First deploy |
| 4 | `scripts/deploy-vertical.sh data "${ARGS[@]}"` | Table changes |
| 5 | `scripts/build-functions.sh --profile "$AWS_PROFILE" --region <region>` | Any Rust change |
| 6 | `scripts/deploy-vertical.sh security "${ARGS[@]}"` | Sign-in changes, or after rotating the Google client |
| 7 | `scripts/deploy-vertical.sh api "${ARGS[@]}"` | API or Lambda changes |
| 8 | `scripts/deploy-vertical.sh hosting "${ARGS[@]}"` | CDN, header or DNS changes |

A Lambda change needs step 5, then the vertical that owns the function: `security` for `auth-presignup` and `api` for the rest.

## Allowlist

```bash
scripts/family-member.sh add <email> --profile "$AWS_PROFILE" --region <region>
scripts/family-member.sh remove <email> --profile "$AWS_PROFILE" --region <region>
scripts/family-member.sh list --profile "$AWS_PROFILE" --region <region>
```

## Resources outside the stacks

The Google OAuth client is in Parameter Store, not in any stack, because CloudFormation cannot create a SecureString. `scripts/set-google-oauth.sh` creates and overwrites it, and nothing tracks it for drift or deletion.

| Parameter | Type |
|---|---|
| `/<stack_name>-<salt>/google-oauth/client-id` | String |
| `/<stack_name>-<salt>/google-oauth/client-secret` | SecureString, AWS-managed key |

- **Creating an environment:** run step 2 before `security`. `deploy-vertical.sh security` refuses to launch while either parameter is missing.
- **Deleting an environment:** deleting the stacks leaves both parameters behind. After the stacks are gone, remove them by hand:

  ```bash
  aws ssm delete-parameters --names /<stack_name>-<salt>/google-oauth/client-id \
    /<stack_name>-<salt>/google-oauth/client-secret --profile "$AWS_PROFILE" --region <region>
  ```

- **A new salt means new parameters.** The names include the salt, so run step 2 again after changing it, and delete the old pair.

## Gotchas

- **A deploy changes real infrastructure.** Confirm with the owner before running one, and never pass `--yes` unless they agreed.
- **First launch of `security`:** pass `--unprotected`, confirm sign-in works, then deploy again without it. A protected pool cannot be removed by a rollback, so a failed first create would leave an orphan behind.
- **The certificate stack waits for DNS validation**, which can take several minutes.
- **A wrong certificate region fails late**, when CloudFront is created in the `hosting` vertical.
- **The API must be published.** `deploy-vertical.sh api` does this, so do not launch the stack with Sceptre directly.
- **Rejected sign-ins are in the logs** of `/aws/lambda/main-fa01-auth-presignup`.
- **Deleting the table or user pool** requires deploying with `deletion_protected: 'false'` first.
