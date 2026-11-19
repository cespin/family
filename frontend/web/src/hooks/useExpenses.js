import { useEffect, useState } from 'react';
import { fetchExpenses } from '../lib/expenses.js';
import { useSession } from './useSession.js';

const PAGE_SIZE = 50;

/**
 * Expenses page by page, newest first. The API does the filtering, so `groupId` and `kind` (null for
 * every one) always find every match. A new `version` reloads the first page behind what is on
 * screen, and so does a later page read at a different revision from the first.
 */
export function useExpenses({ groupId = null, kind = null, version = 0 }) {
  const { getToken, renewToken } = useSession();
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const filters = `${groupId ?? ''}|${kind ?? ''}`;

  useEffect(() => {
    let ignore = false;
    fetchExpenses({ getToken, renewToken }, { groupId, kind, limit: PAGE_SIZE })
      .then((page) => {
        if (ignore) return;
        setResult({
          filters,
          status: 'ready',
          expenses: page.expenses,
          nextCursor: page.nextCursor,
          revision: page.revision,
          loadingMore: false,
          moreErrorCode: null,
        });
      })
      .catch((error) => {
        if (!ignore) setResult({ filters, status: 'failed', errorCode: error?.code ?? 'generic' });
      });
    return () => {
      ignore = true;
    };
  }, [filters, groupId, kind, version, attempt, getToken, renewToken]);

  // A response for other filters is never shown, not even while the new one loads.
  const current = result?.filters === filters ? result : null;

  async function loadMore() {
    const base = current;
    if (base?.status !== 'ready' || !base.nextCursor || base.loadingMore) return;
    const isBase = (candidate) =>
      candidate?.filters === base.filters &&
      candidate.revision === base.revision &&
      candidate.nextCursor === base.nextCursor;

    setResult((latest) =>
      isBase(latest) ? { ...latest, loadingMore: true, moreErrorCode: null } : latest,
    );
    try {
      const page = await fetchExpenses(
        { getToken, renewToken },
        { groupId, kind, cursor: base.nextCursor, limit: PAGE_SIZE },
      );
      if (page.revision !== base.revision) {
        // The ledger changed between pages, so the pages no longer fit together. Start over.
        setAttempt((value) => value + 1);
        return;
      }
      setResult((latest) =>
        isBase(latest)
          ? {
              ...latest,
              expenses: [...latest.expenses, ...page.expenses],
              nextCursor: page.nextCursor,
              loadingMore: false,
            }
          : latest,
      );
    } catch (error) {
      setResult((latest) =>
        isBase(latest)
          ? { ...latest, loadingMore: false, moreErrorCode: error?.code ?? 'generic' }
          : latest,
      );
    }
  }

  function retry() {
    setResult(null);
    setAttempt((value) => value + 1);
  }

  if (!current) return { status: 'loading', retry };
  return { ...current, loadMore, retry };
}
