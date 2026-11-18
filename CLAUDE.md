# family: root orientation

A private family dashboard that grows as needs arrive. Monorepo with two horizontals (`frontend/web`, `backend`) and six Sceptre verticals, deployed in this order: `bootstrap → certificate → data → security → api → hosting`. See `README.md` for the map and `docs/architecture.md` for the design.

## AWS profile and region

**Never write an AWS profile, region or account ID into a file.** They are always mandatory command arguments, with no defaults and no fallback to the environment. Use the AWS profile available in the runtime: `--profile "$AWS_PROFILE"`. `scripts/check-aws-literals.mjs` enforces this and has no path exclusions, so docs use placeholders such as `<region>` and test fixtures use fake values such as `local`.

## Documentation placement convention

This governs where new documentation and gotchas go. Placement is decided by **how a file gets loaded** vs **when its content is actually needed**.

| Home | Loaded | Holds | Budget |
|---|---|---|---|
| **CLAUDE.md** (per dir) | auto, every task in that scope | orientation ("what is this / layout") + the few *always-true* invariants for that scope + a **map** pointing to the detail | short (~60–90 lines) |
| **Rule** (`.claude/rules/`) | auto, on a `paths:` glob match | invariants + prohibitions for a *kind of file* (any `.jsx`, a `*.test.jsx`) | as needed |
| **Skill** (`.claude/skills/`) | on-demand, by task trigger | procedures + gotchas of *doing a kind of work* (deploy, author IaC, write/test Rust, React/Vite) | as needed |
| **README.md** (per folder) | when working inside that folder | durable "what this folder/component/vertical is and how it fits" | medium |
| **Code / banner comment** | when reading that exact code | the gotcha relevant only when editing *this resource/line* | inline |
| **docs/** (root + per horizontal) | on explicit reference, before a significant change | deep current-state design + rationale | long but current-state |

Governing principles:
- **Segment to mirror the tree.** A frontend task must never auto-load backend gotchas; an API-endpoint task must never auto-load Cognito internals. Cross-cutting concerns (auth) live in the shared root `docs/`, referenced from both horizontals.
- **Each fact has one home.** Other places *link* to it; they don't restate it.
- **A gotcha lives next to the thing it constrains.** If it only matters when you touch resource X, it belongs at X (banner comment), in the rule whose glob matches X, or in the skill for that work — not in a CLAUDE.md.
- **A CLAUDE.md restating a rule is paid for twice.** State the invariant once and point.

## Where to go next

- `frontend/web/CLAUDE.md`: frontend orientation and invariants.
- `backend/CLAUDE.md`: backend orientation and invariants.
- `docs/architecture.md`: overall design and how to add a dashboard module.
- `docs/auth/architecture.md`: sign-in and the invite-only allowlist.
