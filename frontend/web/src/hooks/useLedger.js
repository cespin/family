import { useCallback, useEffect, useState } from 'react';
import { fetchLedger } from '../lib/expenses.js';
import { useSession } from './useSession.js';

/**
 * The family's ledger: members, groups, rates and the caller's standings. Loading, failed and ready
 * stay distinct so a failure never reads as empty. A new `version` reloads behind what is on screen;
 * if that reload fails, the ledger stays with `refreshErrorCode` set, so a save that worked never
 * looks as if it failed.
 */
export function useLedger(version = 0) {
  const { getToken, renewToken } = useSession();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

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
  }, [version, attempt, getToken, renewToken]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, retry };
}
