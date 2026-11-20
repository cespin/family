import { useEffect, useState } from 'react';
import { fetchExpenses } from '../lib/expenses.js';
import { useSession } from './useSession.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * The titles of the latest 1000 expenses at most, newest first, as `{ title, transactionDate }`.
 * They only feed title suggestions, so the rules for the expense lists are relaxed on purpose:
 * - The list grows after each page, so the first page can be used at once.
 * - A `revision` change between pages is ignored, because an outdated title list is harmless.
 * - A failure keeps whatever was read and reports nothing, which leaves a plain text field.
 * The titles stay in memory.
 */
export function useTitleHistory() {
  const { getToken, renewToken } = useSession();
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const auth = { getToken, renewToken };
      let cursor = null;
      let loaded = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await fetchExpenses(auth, { limit: PAGE_SIZE, cursor });
        if (ignore) return;
        loaded = [
          ...loaded,
          ...result.expenses.map(({ title, transactionDate }) => ({ title, transactionDate })),
        ];
        setHistory(loaded);
        cursor = result.nextCursor;
        if (!cursor) return;
      }
    }
    // Suggestions are a convenience: a failed read leaves the field as it is, with no error.
    load().catch(() => {});
    return () => {
      ignore = true;
    };
  }, [getToken, renewToken]);

  return history;
}
