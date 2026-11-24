import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLedger } from '../lib/expenses.js';
import { useSession } from './useSession.js';

/**
 * The family's ledger: members, groups, rates and the caller's standings. Loading, failed and ready
 * stay distinct so a failure never reads as empty. A new `version` reloads behind what is on screen;
 * if that reload fails, the ledger stays with `refreshErrorCode` set, so a save that worked never
 * looks as if it failed.
 *
 * A read that finds the exchange rates stale starts an update on the server and answers with the
 * old rates. The hook reads once more after `RATES_FOLLOW_UP_MS` to show the new ones, at most once
 * while it is mounted, so a slow or failing update never turns into polling.
 */
export const RATES_FOLLOW_UP_MS = 5000;

export function useLedger(version = 0) {
  const { getToken, renewToken } = useSession();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [followUp, setFollowUp] = useState(0);
  const followedUp = useRef(false);

  useEffect(() => {
    let ignore = false;
    fetchLedger({ getToken, renewToken })
      .then((ledger) => {
        if (!ignore) setState({ status: 'ready', ledger });
      })
      .catch((error) => {
        if (ignore) return;
        const errorCode = error?.code ?? 'generic';
        setState((current) =>
          current.status === 'ready'
            ? { ...current, refreshErrorCode: errorCode }
            : { status: 'failed', errorCode },
        );
      });
    return () => {
      ignore = true;
    };
  }, [version, attempt, followUp, getToken, renewToken]);

  const updating = state.status === 'ready' && state.ledger.ratesUpdating;
  useEffect(() => {
    if (!updating || followedUp.current) return undefined;
    // Marked when the timer fires, not when it is set, so a cleared timer can be set again.
    const timer = setTimeout(() => {
      followedUp.current = true;
      setFollowUp((current) => current + 1);
    }, RATES_FOLLOW_UP_MS);
    return () => clearTimeout(timer);
  }, [updating]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, retry };
}
