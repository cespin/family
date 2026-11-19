# Sign-in

Family members sign in with Google. Cognito federates the identity and issues the tokens, and only invited addresses get in.

## Flow

1. The app redirects to Cognito's `/oauth2/authorize` with `identity_provider=Google` and a PKCE challenge.
2. After Google, Cognito runs the **pre sign-up** trigger on first sign-in and the **pre token generation** trigger on every token issue. Both are `auth-presignup`.
3. Cognito redirects to `/auth/callback` with an authorization code.
4. The app posts the code and PKCE verifier to `POST /api/auth/session`. The `auth-session` Lambda exchanges them, returns the ID token and stores the refresh token in an `HttpOnly` cookie.
5. On each page load the app calls `POST /api/auth/session/refresh` to restore the session.

## Invariants

- **The refresh token never reaches JavaScript.** The ID token lives in memory only, and nothing is written to `localStorage`.
- **The allowlist is the gate.** `MEMBER#<email>` items in DynamoDB decide who gets in. Manage them with `backend/scripts/family-member.sh`.
- **Removal takes effect quickly.** `GET /api/me` re-reads the allowlist on every call, and a removed member's next token refresh fails. If they sign in again, Cognito refuses during the code exchange and `POST /api/auth/session` answers 403, which the app shows as the not-invited screen.
- **Client-side checks are not security.** Every protected route uses the Cognito authorizer and re-reads the caller's claims.

## From account to member

The expenses design, not deployed yet, links a signed-in account to a member. An `ACCOUNT#<email>` item maps the verified email address to a generated member identifier when the person finishes the first sign-in step. The link is separate from the allowlist and survives removal, so a removed person stays in the family's history and returns as the same member if invited again. The link never grants access: the `MEMBER#<email>` item alone decides who gets in. The item layout is in `backend/docs/dynamodb-schema.md`.

## Google OAuth client

Create a **Web application** client in Google Auth Platform:

- Authorized domain: `amazoncognito.com`
- Scopes: `openid`, email and profile
- Authorized JavaScript origin: `https://<cognito-domain>`
- Authorized redirect URI: `https://<cognito-domain>/oauth2/idpresponse`

`<cognito-domain>` is `<cognito_domain_prefix>.auth.<region>.amazoncognito.com`, using the prefix from `backend/stacks/main.yaml`. Store the client with `backend/scripts/set-google-oauth.sh`, then deploy the `security` vertical.
