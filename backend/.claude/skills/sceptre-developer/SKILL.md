---
name: sceptre-developer
description: Author Sceptre config and CloudFormation templates for the family dashboard backend. Use when adding or changing a vertical, a stack, a Lambda's infrastructure, an API Gateway route in the inline OpenAPI document, or a value passed between stacks with Fn::ImportValue or !stack_output_external. For running deploys, use backend-deploy.
---

# Sceptre Developer

Guidance for extending the Sceptre project in `backend/`. Paths are relative to `backend/`. This skill covers design and authoring. To run a deploy, use the `backend-deploy` skill.

## Layout

Each vertical is a directory of Sceptre config mirrored by a directory holding one raw CloudFormation template:

```text
config/<vertical>/stack.yaml     → template: {path: <vertical>/stack.yaml, type: file}
templates/<vertical>/stack.yaml
```

`config/config.yaml` holds the settings every stack inherits. A `config/<vertical>/config.yaml` overrides them for one vertical. Templates are plain YAML, and only the config files are rendered with Jinja.

Verticals deploy in this order, and each one is launched on its own:

| # | Vertical | Owns | Exports (`fam-main-<Name>`) |
|---|---|---|---|
| 1 | `bootstrap` | Artifacts bucket | `ArtifactsBucketName` |
| 2 | `certificate` | TLS certificate, in the certificate region | None. Has the output `CertificateArn` |
| 3 | `data` | DynamoDB table | `FamilyTableName`, `FamilyTableArn` |
| 4 | `security` | Cognito user pool, Google federation, allowlist trigger | `UserPoolArn`, `UserPoolClientId`, `CognitoDomain` |
| 5 | `api` | REST API and its Lambdas | `RestApiId` |
| 6 | `hosting` | S3, CloudFront, security headers, DNS | `DistributionId`, `WebappS3BucketName` |

## Naming

`stacks/main.yaml` defines `app_name: family`, `export_key: fam`, `stack_name: main` and `salt: fa01`. They produce three separate naming schemes. Reuse one of them and don't invent a fourth.

| What | Pattern | Example |
|---|---|---|
| CloudFormation stack | `{{ var.stack_name }}-{{ var.app_name }}-<vertical>` | `main-family-api` |
| CloudFormation export | `${ExportKey}-${StackName}-<Name>` | `fam-main-RestApiId` |
| Physical resource | `${StackName}-${Salt}-<resource>` | `main-fa01-family` |

Buckets use `BucketNamePrefix: !Sub '${StackName}-${Salt}-<purpose>'` with `BucketNamespace: account-regional`.

## The mandatory-argument rule

**An AWS profile, region or account ID is never written into a file.** They are required command arguments with no defaults, and nothing falls back to the environment.

- `config/config.yaml` reads `{{ var.profile }}` and `{{ var.region }}`, and `config/certificate/config.yaml` reads `{{ var.certificate_region }}`. `scripts/deploy-vertical.sh` supplies all three with `--var`. Never add them to `stacks/main.yaml`.
- Every script that talks to AWS sources `scripts/lib/aws-args.sh`, defines `usage()`, calls `parse_aws_args "$@"` and then `apply_aws_args`. A new one does the same.
- `../scripts/check-aws-literals.mjs` fails the deploy if a region, a 12-digit account ID or the profile in use appears in any file. It has no path exclusions, so docs use placeholders such as `<region>`.
- Never name the certificate region in a file. It is always the `--certificate-region` argument.

```bash
scripts/deploy-vertical.sh <vertical> --profile "$AWS_PROFILE" --region <region> --certificate-region <certificate-region>
scripts/build-functions.sh --profile "$AWS_PROFILE" --region <region>
```

## Passing a value between stacks

| Situation | Use | Example |
|---|---|---|
| Between verticals in the same region | `Fn::ImportValue` in the template, built from the export name | `api` importing `fam-main-UserPoolArn` |
| From the certificate stack, which is in the certificate region | `!stack_output_external` in the Sceptre config | `CertificateArn` in `config/hosting/stack.yaml` |
| A value two verticals must agree on | A var in `stacks/main.yaml` | `domain_name` in `security`, `api` and `hosting` |

### `Fn::ImportValue` between verticals

Every same-region link has this shape:

```yaml
TABLE_NAME: !ImportValue
  'Fn::Sub': '${ExportKey}-${StackName}-FamilyTableName'
```

The import works anywhere in a template, including inside the OpenAPI `Body`. A new output that another vertical needs gets an `Export` with the name pattern above.

No config in this project has a `dependencies:` key, and a link between verticals should not add one. Verticals are deployed independently, and a dependency would pull the upstream stack into every downstream launch.

Ordering is enforced by a pre-flight check instead. **Each upstream vertical a stack imports from needs a `require_export` call** in that vertical's `case` branch of `scripts/deploy-vertical.sh`. One probe per upstream vertical is enough, so a new import from a vertical the branch already checks needs no new call:

```bash
require_export FamilyTableArn data >/dev/null
```

It stops the deploy with a message naming the vertical to deploy first.

### `!stack_output_external` for the certificate

CloudFront reads its certificate from one fixed region, so the `certificate` stack may live apart from the application stacks. `Fn::ImportValue` cannot cross regions, which is why that stack has no `Export`. `config/hosting/stack.yaml` reads its output directly, naming the real stack and where to find it:

```yaml
CertificateArn: !stack_output_external {{ var.stack_name }}-{{ var.app_name }}-certificate::CertificateArn {{ var.profile }}::{{ var.certificate_region }}
```

The lookup fails loudly when the output is missing.

Don't replace it with `!stack_output`. In the installed Sceptre 4.7.0 that resolver builds the name it queries from `project_code` and the config path, which gives `family-certificate-stack`. Every stack here sets its own `stack_name`, so that stack does not exist.

## Adding a vertical

1. Create `templates/<vertical>/stack.yaml` and `config/<vertical>/stack.yaml`.
2. In `scripts/deploy-vertical.sh`, add it to `VERTICALS` and add a `case` branch with a `require_export` for each upstream vertical it imports from.
3. If the template can outgrow the inline limit, add a `config/<vertical>/config.yaml` with `template_bucket_name` and call `add_template_bucket` in that branch, as `api` and `hosting` do.
4. Add it to the deploy order in `.claude/skills/backend-deploy/SKILL.md` and to the verticals table in `../docs/architecture.md`.

`stack_var` in `scripts/lib/aws-args.sh` only reads flat `key: value` lines, so keep `stacks/main.yaml` flat.

## Stateful resources

`data` and `security` own state that must outlive the stack.

- **Set both policies.** `DeletionPolicy` covers a stack delete and `UpdateReplacePolicy` covers a replacing update. `FamilyTable` and `UserPool` use `!If [IsDeletionProtected, Retain, Delete]` for both.
- **Also set the service's own protection.** `DeletionProtectionEnabled` on the table and `DeletionProtection` on the pool stop deletes that bypass CloudFormation.
- **`Fn::If` on those two attributes needs `Transform: 'AWS::LanguageExtensions'`.** Only `data` and `security` declare it.
- **Keep `deletion_protected` quoted** in `stacks/main.yaml`. Unquoted, it reaches CloudFormation as `True` and the template's `AllowedValues` rejects it.
- **Deleting takes two steps:** deploy with `deletion_protected: 'false'`, then delete.
- **`Retain` orphans on replacement.** A replacing change to the pool strands every user in the old pool, so treat key schema and pool schema edits as migrations.
- **`scripts/ddb-local.sh` creates the same table** and must stay identical to `templates/data/stack.yaml`.

## Adding a Lambda

1. Create the crate under `functions/<crate>/` and add it to `members` in `functions/Cargo.toml`.
2. Add the crate name to `FUNCTIONS` in `scripts/build-functions.sh`. A crate missing from that list is never packaged.
3. Add a `<Name>CodeS3Key` parameter to the template, and pass it from the vertical's config. The script records each hash as `code_<crate with underscores>` in the generated, gitignored `stacks/main.build.yaml`:

   ```yaml
   MeGetCodeS3Key: lambda/me-get/{{ var.code_me_get }}/bootstrap.zip
   ```

4. Declare the role, log group and function in the template, following `MeGetRole`, `MeGetLogGroup` and `MeGetFunction` in `templates/api/stack.yaml`:

   - **One role per function,** named `${StackName}-${Salt}-<crate>`, with `AWSLambdaBasicExecutionRole` plus only the actions that handler calls.
   - **A declared `AWS::Logs::LogGroup` with `RetentionInDays: 30`.** Its name must be `/aws/lambda/<FunctionName>`, and the function has `DependsOn` on it.
   - **Fixed runtime shape:** `Runtime: provided.al2023`, `Architectures: [arm64]`, `Handler: bootstrap`.
   - **Code from the artifacts bucket:** import `ArtifactsBucketName` for `S3Bucket` and use the parameter for `S3Key`.

A vertical with named IAM roles needs `CAPABILITY_NAMED_IAM` under `capabilities:` in its config, as `security` and `api` have.

## Adding an API route

The `RestApi` `Body` is the OpenAPI contract. Use the `api-design` skill for the contract itself. The infrastructure needs:

- **An integration on the operation.** `httpMethod` is always `POST`, whatever the route's method:

  ```yaml
  x-amazon-apigateway-integration:
    type: aws_proxy
    httpMethod: POST
    uri: !Sub 'arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MeGetFunction.Arn}/invocations'
  ```

- **An `AWS::Lambda::Permission`** scoped to the method and path, with the stage as a wildcard: `${RestApi}/*/GET/api/me`. A path parameter is also a `*` in this ARN.
- **The authorizer by reference.** Add `security: [{ CognitoUserPool: [] }]` to the operation. The scheme is declared once under `components.securitySchemes`. Don't add an `AWS::ApiGateway::Authorizer` resource, because the imported document defines the API's authorizers.

**There is no `AWS::ApiGateway::Deployment` or `Stage` in the template, on purpose.** CloudFormation does not publish a new deployment when `Body` changes. `scripts/deploy-vertical.sh` publishes a new deployment and sets stage throttling after every `api` launch, so always deploy `api` through that script.

A template that parses can still fail at deploy time, because API Gateway only evaluates the OpenAPI document when it imports it. Keep route changes small and read the stack events when one fails.

## Gotchas in the existing stacks

- **Circular dependency in `security`.** `UserPool` references `AuthPresignupFunction`, so that function's environment cannot reference the pool. Cognito passes what the trigger needs in the event.
- **Secrets reach a stack as `NoEcho` parameters resolved with `!rcmd`, never through Jinja.** Follow `GoogleClientSecret` in `config/security/stack.yaml`, whose comment explains the command's shape. Rotating the Google client needs only `scripts/set-google-oauth.sh` and a `security` deploy.
- **Refresh token lifetime.** `RefreshTokenValidity` in `templates/security/stack.yaml` must equal `MAX_AGE_SECONDS` in `functions/auth-session/src/cookie.rs`, and a test enforces it.
- **Cognito domain prefixes are global.** `scripts/deploy-vertical.sh` checks for a taken prefix before launching `security`.
- **No `CustomErrorResponses` on the distribution.** They apply to every behavior, so an API 403 would reach the browser as a 200 with `index.html`. The SPA fallback lives in `ViewerRequestFunction` in `templates/hosting/stack.yaml`.
- **A new file in `../frontend/web/public/`** must be added to `STATIC_ROOT_FILES` in that function, or it serves `index.html`.
- **One CloudFront Function per event type per cache behavior.** The default behavior's `viewer-request` slot is taken, so new logic for that event goes into `ViewerRequestFunction`.
- **The webapp bucket's lifecycle rule expires `stages/`.** The live site must stay under `default/`.
- **The hosting CSP allows same-origin content only.** A new third-party origin needs a change to `SecurityHeadersPolicy`.
