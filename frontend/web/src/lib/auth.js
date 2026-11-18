import { ApiError, apiFetch } from './api.js';

const PKCE_KEY = 'fa_oauth_pending';
export const CALLBACK_PATH = '/auth/callback';

/** Thrown when Cognito refuses a Google account that is not on the family allowlist. */
export class NotInvitedError extends Error {}

const cognitoDomain = () => import.meta.env.VITE_COGNITO_DOMAIN;
const clientId = () => import.meta.env.VITE_COGNITO_CLIENT_ID;

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function randomString() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Redirects to Google through Cognito. The verifier survives the redirect in this tab only. */
export async function startSignIn() {
  const state = randomString();
  const verifier = randomString();
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, verifier }));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: `${window.location.origin}${CALLBACK_PATH}`,
    identity_provider: 'Google',
    scope: 'openid email profile',
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`https://${cognitoDomain()}/oauth2/authorize?${params}`);
}

/** Finishes the redirect back from Cognito and returns the ID token. */
export async function completeSignIn(search) {
  const params = new URLSearchParams(search);
  const pending = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null');
  sessionStorage.removeItem(PKCE_KEY);

  // The trigger's refusal text arrives here. See NOT_INVITED in functions/auth-presignup.
  if (params.get('error_description')?.includes('not_invited')) throw new NotInvitedError();

  const code = params.get('code');
  if (!code || !pending || params.get('state') !== pending.state) {
    throw new ApiError(400, 'request_error');
  }
  const { idToken } = await apiFetch('/auth/session', {
    method: 'POST',
    body: { code, codeVerifier: pending.verifier },
  });
  return idToken;
}

/** Restores a session from the HttpOnly cookie. Returns null when there is none. */
export async function restoreSession() {
  try {
    const { idToken } = await apiFetch('/auth/session/refresh', { method: 'POST' });
    return idToken;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Ends the session here and at Cognito, so the next sign-in asks again. */
export async function signOut() {
  await apiFetch('/auth/session', { method: 'DELETE' }).catch(() => null);
  const params = new URLSearchParams({
    client_id: clientId(),
    logout_uri: `${window.location.origin}/`,
  });
  window.location.assign(`https://${cognitoDomain()}/logout?${params}`);
}
