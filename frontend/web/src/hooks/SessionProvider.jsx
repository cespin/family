import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import {
  CALLBACK_PATH,
  NotInvitedError,
  completeSignIn,
  restoreSession,
  signOut,
  startSignIn,
} from '../lib/auth.js';
import { SessionContext } from './useSession.js';

// Renews before the 60-minute ID token expires.
const RENEW_AFTER_MS = 55 * 60 * 1000;

// Only the exact value 1 in a dev build skips real sign-in.
const MOCK_SESSION = import.meta.env.DEV && import.meta.env.VITE_MOCK_SESSION === '1';
// The sample ledger's caller, as GET /api/me would describe them. See src/lib/expenses.sample.js.
const MOCK_STATE = {
  status: 'signedIn',
  member: {
    email: 'dev@example.test',
    name: 'Carlos',
    memberId: 'carlos',
    displayName: 'Carlos',
    homeCurrency: 'CAD',
  },
};

// Someone who has not finished the first sign-in step has no member profile yet.
const signedInAs = (member) => ({
  status: member?.memberId == null ? 'needsProfile' : 'signedIn',
  member,
});

export function SessionProvider({ children }) {
  const [state, setState] = useState(MOCK_SESSION ? MOCK_STATE : { status: 'loading' });
  // The ID token stays in memory only. The refresh token is in an HttpOnly cookie.
  const tokenRef = useRef(null);

  const establish = useCallback(async (idToken) => {
    tokenRef.current = idToken;
    const member = await apiFetch('/me', { token: idToken });
    return signedInAs(member);
  }, []);

  // Works out the session state without touching React state, so callers decide when to apply it.
  const resolveSession = useCallback(async () => {
    try {
      const { pathname, search } = window.location;
      const idToken =
        pathname === CALLBACK_PATH ? await completeSignIn(search) : await restoreSession();
      if (pathname === CALLBACK_PATH) window.history.replaceState(null, '', '/');
      return idToken ? await establish(idToken) : { status: 'signedOut' };
    } catch (error) {
      window.history.replaceState(null, '', '/');
      if (error instanceof NotInvitedError || error?.status === 403) {
        return { status: 'notInvited' };
      }
      return { status: 'failed', errorCode: error?.code ?? 'generic' };
    }
  }, [establish]);

  useEffect(() => {
    if (!MOCK_SESSION) resolveSession().then(setState);
  }, [resolveSession]);

  useEffect(() => {
    if (MOCK_SESSION || (state.status !== 'signedIn' && state.status !== 'needsProfile')) {
      return undefined;
    }
    const timer = setTimeout(() => {
      resolveSession().then((next) =>
        setState(next.status === 'failed' ? { status: 'signedOut' } : next),
      );
    }, RENEW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state, resolveSession]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    resolveSession().then(setState);
  }, [resolveSession]);

  // For a data call refused with 401: the token expired before the scheduled renewal. Returns the
  // new token, or null when the session has ended, in which case the sign-in screen takes over.
  // Calls refused at the same time share one renewal.
  const renewalRef = useRef(null);
  const renewToken = useCallback(() => {
    if (MOCK_SESSION) return Promise.resolve(null);
    renewalRef.current ??= restoreSession()
      .then((idToken) => {
        tokenRef.current = idToken;
        if (!idToken) setState({ status: 'signedOut' });
        return idToken;
      })
      .catch(() => null)
      .finally(() => {
        renewalRef.current = null;
      });
    return renewalRef.current;
  }, []);

  // Stable, so data hooks that depend on it do not reload when the session state changes.
  const getToken = useCallback(() => tokenRef.current, []);

  // Replaces the member with the answer to PUT /api/me/profile.
  const updateMember = useCallback((member) => setState(signedInAs(member)), []);

  const value = useMemo(
    () => ({
      ...state,
      signIn: startSignIn,
      signOut,
      retry,
      renewToken,
      updateMember,
      getToken,
    }),
    [state, retry, renewToken, updateMember, getToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
