---
paths:
  - "**/*.jsx"
  - "**/hooks/**/*.js"
  - "**/use*.js"
---
# React Hooks — frontend/web

> Covers React hooks (`useState`, `useEffect`, custom hooks), not the Claude Code hooks runtime.

## Rules of Hooks

oxlint reports a violation as an error, through `react/rules-of-hooks` in `.oxlintrc.json`.

1. Hooks only at the top level of a component or another hook.
2. Never in loops, conditionals, nested functions, or after an early return.
3. Same order every render.
4. Only inside components or functions starting with `use`.

## Dependency arrays

oxlint warns about a missing dependency through `react-hooks/exhaustive-deps`. Fix the warning by reasoning about what the effect closes over. If you deliberately omit something, explain why in a comment next to the pragma:

```jsx
// oxlint-disable-next-line react-hooks/exhaustive-deps
```

## `useSession`

`useSession` in `src/hooks/useSession.js` is the app's one project hook. It reads the context that `SessionProvider` in `src/hooks/SessionProvider.jsx` supplies, and throws if used outside that provider.

| Field | Meaning |
|---|---|
| `status` | `loading`, `signedOut`, `notInvited`, `failed` or `signedIn` |
| `member` | The signed-in member from `GET /api/me`, when `status` is `signedIn` |
| `errorCode` | The API error code, when `status` is `failed` |
| `signIn()` | Starts the redirect to Google through Cognito |
| `signOut()` | Ends the session on the server and at Cognito |
| `retry()` | Resolves the session again after a failure |
| `getToken()` | The current ID token, read from memory |

- **Call `getToken()` when you make the request.** Don't copy the token into state or keep it in a variable across renders, because the provider renews it before it expires.
- **`member.name` is optional.** Handle a profile without one, as `src/screens/DashboardScreen.jsx` does.
- **`status` is a UI decision, not a security check.** See `security.md`.
- **Keep the provider and the hook in separate files.** A component file exports only components, which is what `react/only-export-components` checks.
- **In tests, mock `src/hooks/useSession.js`.** See `testing.md`.

## Data fetching

There is no TanStack Query or SWR. Don't add a cache library to solve a fetching problem. Write a narrow custom hook over `apiFetch`, and handle what a naive effect gets wrong:

- **Stale responses.** `apiFetch` takes no abort signal, so set an ignore flag in the effect's cleanup and drop a response that arrives late.
- **Separate states.** Keep loading, failed and loaded apart, so a failure can't render as empty data. See "Absent is not zero" in `patterns.md`.

## `useEffect`: when not to use it

Don't use `useEffect` for derived state, transforming data for render, or resetting state on a prop change. Compute it during render instead.

```jsx
// WRONG
const [fullName, setFullName] = useState('');
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// CORRECT
const fullName = `${first} ${last}`;
```

Every subscription, interval, listener or in-flight request needs a cleanup. `SessionProvider` clears its renewal timer this way.

## `useMemo`/`useCallback`

Reach for `useCallback` or `useMemo` when a value is itself a dependency of another hook, or is a context value whose identity would re-render every consumer. `SessionProvider` uses them for exactly those reasons. Don't add memoization speculatively.

## `useRef`

- Holding a value that must survive renders without causing one.
- Holding the ID token, as `tokenRef` does in `SessionProvider`. It lives in memory only and dies on reload.

## Custom hooks

Extract one when the same state and effect sequence appears in 2+ places, or the logic should be tested independently of a component. Don't extract a hook with a single caller that is just `useState` under a different name.

## React 19

Newer hooks such as `useActionState` and `useOptimistic` are available but not used yet. Adopt one when a screen has the problem it solves.

## Stale-closure trap

Async handlers and timers close over the render they were created in. Use a functional updater (`setCount((prev) => prev + 1)`) when new state depends on old, and a ref when a long-lived callback must read the latest value.
