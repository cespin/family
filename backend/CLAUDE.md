# backend: orientation

Rust Lambdas (`functions/`), CloudFormation templates (`templates/<vertical>/`) and their Sceptre configuration (`config/<vertical>/`, mirroring the templates).

## Layout

- `functions/family-core`: shared errors, HTTP helpers, claims and allowlist access.
- `functions/<route>`: one crate per Lambda, kept thin.
- `stacks/main.yaml`: environment values. `stacks/main.build.yaml` is generated and gitignored.
- `scripts/`: the only supported way to build and deploy.

## Invariants

- **AWS profile and regions are mandatory script arguments.** Scripts get them through `scripts/lib/aws-args.sh` and never read them from the environment.
- **Build all functions together** with `scripts/build-functions.sh`, and never deploy a subset.
- **`cargo test --workspace` is hermetic.** It must pass with no AWS credentials and nothing running.
- **Error `code` values are a contract** with the frontend, which translates them. `message` is English diagnostic text that users never see.
- **Every Lambda has its own role and a declared log group** with 30-day retention.

## Checks

From `functions/`: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`.

## Map

- Deploying: the `backend-deploy` skill.
- Writing stacks: the `sceptre-developer` skill.
- API conventions: `docs/api-contract.md` and the `api-design` skill.
- Table layout: `docs/dynamodb-schema.md`.
- Sign-in: `../docs/auth/architecture.md`.
