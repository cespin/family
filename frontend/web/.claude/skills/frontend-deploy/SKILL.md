---
name: frontend-deploy
description: Build, stage, preview and promote the family dashboard frontend. Use when publishing the React app, previewing a staged build, or making a staged build live.
---

# Frontend deploy

Run from `frontend/web/` with Node 26. The profile and region are required arguments.

```bash
D=.claude/skills/frontend-deploy/scripts/deploy.sh

$D --profile "$AWS_PROFILE" --region <region>                    # lint, test, build and stage
$D --list-stages --profile "$AWS_PROFILE" --region <region>      # list staged builds
$D --promote <hash> --profile "$AWS_PROFILE" --region <region>   # make a stage live
```

## Flow

1. Staging uploads to `stages/<hash>/` and leaves the live site untouched.
2. Open `/?setStage=<hash>` to preview that build in your browser. Open `/?setStage=` to go back to the live site.
3. Promoting copies the stage to `default/` and invalidates CloudFront.

## Gotchas

- **Confirm with the owner before promoting.** It changes the live site.
- **Staged builds are unlisted, not access-controlled.** Never bake family data into a build.
- **A new file in `public/`** must also be added to `STATIC_ROOT_FILES` in `backend/templates/hosting/stack.yaml`, or it serves `index.html`.
- **Cognito settings are injected at build time** from stack outputs, so the backend must be deployed first.
