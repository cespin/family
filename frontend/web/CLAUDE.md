# frontend/web: orientation

React 19 single-page app in plain JSX, built with Vite. TypeScript and a root router are deliberately not used. `src/App.jsx` picks the screen from the session state.

## Layout

- `src/screens/`: one component per screen.
- `src/components/ui/`: the in-house design system.
- `src/components/expenses/`, `src/components/auth/`: pieces shared by that module's screens.
- `src/hooks/`: `SessionProvider` and `useSession`, and the data hooks over the seam (`useLedger`, `useExpenses`, `useExpense`, `useTitleHistory`, `useRequestId`).
- `src/lib/`: API client, sign-in flow, the expenses API seam (`expenses.js`) with its dev-only stand-in (`expenses.sample.js`), and money logic. The API owns balances: nothing in production code allocates payments.
- `src/i18n/`: translations and formatting.
- `src/styles/tokens/`: design tokens.

## Invariants

- **All user-visible text comes from the translation catalogs.** See the `i18n` rule.
- **Tokens only in CSS**, with classes prefixed `fa-`: no literal colours, spacing, radii or durations.
- **Client-side checks are not security.** The API re-checks every protected route.
- **The ID token stays in memory.** Nothing sensitive goes in `localStorage`.

## Checks

`npm run lint`, `npm run test` and `npm run build` must all be clean.

## Map

- Deploying: the `frontend-deploy` skill.
- Sign-in: `../../docs/auth/architecture.md`.
- Rules for each kind of file: `.claude/rules/`.
