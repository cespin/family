---
paths:
  - "**/*.jsx"
  - "**/*.js"
---
# Security — frontend/web

This app is a static SPA behind CloudFront calling a same-origin `/api/*`. It has no server rendering. Paths are relative to `frontend/web/`. The sign-in design is in `../../docs/auth/architecture.md`.

## Token storage

| Credential | Where | Who can read it |
|---|---|---|
| ID token (60 minutes) | `tokenRef`, a `useRef` in `src/hooks/SessionProvider.jsx` | This page's JavaScript only |
| Refresh token (7 days) | `__Secure-fa_session` cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/auth/session` | The server only |
| Access token | Never sent to the browser | Nobody here |

- **Never put a token in `localStorage`, `sessionStorage`, React state, a URL or a log.** Read the ID token through `getToken()` from `useSession` when making a call.
- **The one `sessionStorage` entry is the PKCE pair.** `src/lib/auth.js` keeps the OAuth `state` and verifier under `fa_oauth_pending` to survive the redirect, and removes it on return. Nothing else goes there.
- **The cookie's `Path` is load-bearing.** It keeps the refresh token out of every other Lambda's event. Don't widen it.
- **The API expects the ID token.** `src/lib/api.js` sends it as the raw `Authorization` value, with no `Bearer` prefix.

## Client-side checks are convenience, never security

`status` from `useSession` decides which screen to show. It does not decide what the server allows. Hiding a button or a screen protects nothing.

Every protected route is enforced by the API: the Cognito authorizer validates the token, and the handler reads the caller from its claims. `GET /api/me` also re-reads the invite-only allowlist. Any new permission rule must be enforced in the backend first.

## Sign-out must reach the server

JavaScript cannot clear an `HttpOnly` cookie. `signOut()` in `src/lib/auth.js` calls `DELETE /api/auth/session` to revoke the token and clear the cookie, then redirects to Cognito's logout. A sign-out that only resets client state is undone by the next page load, which restores the session from the cookie. Always use `signOut` from `useSession`.

## Mock session

`VITE_MOCK_SESSION=1` skips real sign-in, and it only takes effect when `import.meta.env.DEV` is true. Keep both conditions, with the exact value `'1'`, so a production build can never run with a simulated session.

## External links

No external link exists in the app yet. When adding one:

- Links that open a new tab use `target="_blank" rel="noreferrer"`, which also implies `noopener`.
- A URL supplied by a user or the server must have its scheme validated before it reaches `href` or `src`. Allow `https:` and reject `javascript:` and `data:`.

## No `dangerouslySetInnerHTML`

None exists in the app. Adding it is a review-halting change that requires an allowlist-based sanitizer at the exact call site. Family members' text renders as plain text through React's escaping.

i18next runs with `escapeValue: false` because React already escapes rendered values, so a translated string must never be passed to `dangerouslySetInnerHTML`.

## Third-party origins are blocked in production

The Content Security Policy in `../../backend/templates/hosting/stack.yaml` allows scripts, styles, fonts and connections from the site's own origin only. A CDN script, web font or external API may work in `npm run dev` and fail after deploy. Bundle the asset, or change the policy deliberately.

## Env vars are public

Every `VITE_`-prefixed variable is inlined into the client bundle and must be treated as public.

- `VITE_COGNITO_DOMAIN` and `VITE_COGNITO_CLIENT_ID` identify a public OAuth client. The deploy script injects them at build time.
- Never give a secret a `VITE_` prefix. A secret belongs in the backend.
- Staged builds are unlisted, not access-controlled, so never bake family data into a build or an env var.
