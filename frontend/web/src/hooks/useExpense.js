import { useEffect, useState } from 'react';
import { fetchExpense } from '../lib/expenses.js';
import { useSession } from './useSession.js';

/** One expense in full, or `{ status: 'ready', expense: null }` when there is no `expenseId`. */
export function useExpense(expenseId, version = 0) {
  const { getToken, renewToken } = useSession();
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!expenseId) return undefined;
    let ignore = false;
    fetchExpense({ getToken, renewToken }, expenseId)
      .then((expense) => {
        if (!ignore) setResult({ expenseId, status: 'ready', expense });
      })
      .catch((error) => {
        if (!ignore) setResult({ expenseId, status: 'failed', errorCode: error?.code ?? 'generic' });
      });
    return () => {
      ignore = true;
    };
  }, [expenseId, version, attempt, getToken, renewToken]);

  function retry() {
    setResult(null);
    setAttempt((value) => value + 1);
  }

  if (!expenseId) return { status: 'ready', expense: null, retry };
  if (result?.expenseId !== expenseId) return { status: 'loading', retry };
  return { ...result, retry };
}
