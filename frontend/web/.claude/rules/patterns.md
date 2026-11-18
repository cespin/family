---
paths:
  - "**/*.jsx"
  - "**/*.js"
---
# React Patterns — frontend/web

This is a client-rendered Vite SPA. Every pattern below describes what this codebase does.

## One entry, no router

`src/main.jsx` mounts `SessionProvider` around `App`. `src/App.jsx` looks up the screen for the current session `status` in its `SCREENS` object. There is no router at the root, and adding one is a deliberate project decision.

Screens live in `src/screens/`, one component per screen, and shared primitives live in `src/components/ui/`.

## State location

1. Local to one component → `useState`.
2. Shared by a few components → lift to the nearest common ancestor.
3. Cross-cutting and low-frequency → React Context. The only one today is `SessionContext`, provided by `src/hooks/SessionProvider.jsx` and read through `useSession`.
4. Server-derived data → a narrow custom hook over `apiFetch` (see `hooks.md`). The project has no cache library.

There is no Zustand, Jotai or Redux. Don't introduce one without an explicit decision to add the dependency.

## Absent is not zero

**A value the app does not have must render as absent, never as `0`.** This matters most for shared finances: a family member who reads a balance of zero will act on it. A fabricated zero is a false statement about the family's money, and it looks exactly like a true one.

- Keep "not loaded", "failed", "no value recorded" and a real `0` as different states.
- Render a missing value as an explicit placeholder from the catalog, not as a number.
- Never write `amount ?? 0`, `amount || 0` or `Number(amount)` for a value headed to the screen.
- Check with `amount == null`, which catches both `null` and `undefined`. A real `0` must pass through and render as zero.
- **Check before formatting.** The formatters do not protect you: `formatCurrency(null, currency)` prints a zero amount, `formatCurrency(undefined, currency)` prints `NaN`, and `formatDate(null)` prints the Unix epoch date.
- A total that includes a missing amount is not a total. Show it as incomplete instead of summing the amounts you have.
- A failed load shows the error state, not an empty list or a zero total.

```jsx
function Balance({ amount, currency }) {
  const { t } = useTranslation();
  if (amount == null) return <span>{t('common:status.noData')}</span>;
  return <span>{formatCurrency(amount, currency)}</span>;
}
```

`common:status.noData` is illustrative. Add the key to the catalog before using it.

## Data fetching

All API calls go through `apiFetch` in `src/lib/api.js`. It prefixes `/api`, takes `{ method, body, token }`, and throws `ApiError` carrying the backend's `status` and `code`.

| What | How |
|---|---|
| A read a screen needs | A custom hook over `apiFetch`, guarded against stale responses |
| A write from a user action | `apiFetch` in the event handler |
| The caller's token | `getToken()` from `useSession` |
| An error shown to the user | `errorMessage(error.code)` from `src/i18n/errors.js` |

## Forms

No form exists yet. Default to controlled inputs with a handler that calls the API on submit. `Button` defaults to `type="button"`, so a submit button must pass `type="submit"`.

## Lists and keys

Use stable, per-item keys. Never use the array index for anything that can reorder, insert, or be deleted.

## Out of scope for this project

Do not apply guidance for server rendering, TypeScript, or data-fetching and state libraries. None of it is present, and none should be introduced without an explicit decision.
