# Familia

A private dashboard for the family. It starts empty and grows as needs arrive.

| Folder | What it holds |
|---|---|
| `frontend/web/` | React single-page app |
| `backend/` | Rust Lambdas, CloudFormation templates and Sceptre configuration |
| `docs/` | Architecture and sign-in design |
| `scripts/` | Repository-wide checks |

## Prerequisites

Node 26 (`nvm use`), Rust with `cargo-lambda` and `cargo-deny`, `uv`, the AWS CLI, and Sceptre:

```bash
cd backend
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

## Local development

```bash
cd frontend/web && npm install && npm run dev   # simulated session, no backend needed
cd backend/functions && cargo test --workspace  # needs no AWS credentials
```

## Deploying

Every AWS command takes the profile and regions as required arguments. Nothing is stored in the repository.

```bash
ARGS=(--profile "$AWS_PROFILE" --region <region> --certificate-region <certificate-region>)

cd backend
scripts/deploy-vertical.sh bootstrap "${ARGS[@]}"
scripts/set-google-oauth.sh --profile "$AWS_PROFILE" --region <region>
scripts/deploy-vertical.sh certificate "${ARGS[@]}"
scripts/deploy-vertical.sh data "${ARGS[@]}"
scripts/build-functions.sh --profile "$AWS_PROFILE" --region <region>
scripts/deploy-vertical.sh security "${ARGS[@]}" --unprotected   # first launch only, redeploy without it once sign-in works
scripts/deploy-vertical.sh api "${ARGS[@]}"
scripts/deploy-vertical.sh hosting "${ARGS[@]}"
scripts/family-member.sh add <email> --profile "$AWS_PROFILE" --region <region>

cd ../frontend/web
.claude/skills/frontend-deploy/scripts/deploy.sh --profile "$AWS_PROFILE" --region <region>
.claude/skills/frontend-deploy/scripts/deploy.sh --promote <hash> --profile "$AWS_PROFILE" --region <region>
```

The certificate region is the one CloudFront requires for its certificates.
