import { useCallback, useEffect, useState } from 'react';
import { fetchLedger } from '../lib/expenses.js';

/** The family's ledger. Loading, failed and ready stay distinct so a failure never reads as empty. */
export function useLedger() {
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    fetchLedger()
      .then((ledger) => {
        if (!ignore) setState({ status: 'ready', ledger });
      })
      .catch((error) => {
        if (!ignore) setState({ status: 'failed', errorCode: error?.code ?? 'generic' });
      });
    return () => {
      ignore = true;
    };
  }, [attempt]);

  // Refreshes behind what is on screen, for after a save.
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, reload, retry };
}
