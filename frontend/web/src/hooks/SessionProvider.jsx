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
const MOCK_STATE = { status: 'signedIn', member: { name: 'Familia', email: 'dev@example.test' } };

export function SessionProvider({ children }) {
  const [state, setState] = useState(MOCK_SESSION ? MOCK_STATE : { status: 'loading' });
  // The ID token stays in memory only. The refresh token is in an HttpOnly cookie.
  const tokenRef = useRef(null);

  const establish = useCallback(async (idToken) => {
    tokenRef.current = idToken;
    const member = await apiFetch('/me', { token: idToken });
    return { status: 'signedIn', member };
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
    if (MOCK_SESSION || state.status !== 'signedIn') return undefined;
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

  const value = useMemo(
    () => ({ ...state, signIn: startSignIn, signOut, retry, getToken: () => tokenRef.current }),
    [state, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
