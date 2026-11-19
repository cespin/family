import { useEffect, useState } from 'react';
import { fetchPayments } from '../lib/expenses.js';
import { useSession } from './useSession.js';

const PAGE_SIZE = 50;

/**
 * The caller's payments and advances page by page, newest first. A new `version` reloads the first
 * page, and so does a later page read at a different revision from the first.
 */
export function usePayments(version = 0) {
  const { getToken, renewToken } = useSession();
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    fetchPayments({ getToken, renewToken }, { limit: PAGE_SIZE })
      .then((page) => {
        if (ignore) return;
        setResult({
          status: 'ready',
          payments: page.payments,
          nextCursor: page.nextCursor,
          revision: page.revision,
          loadingMore: false,
          moreErrorCode: null,
        });
      })
      .catch((error) => {
        if (!ignore) setResult({ status: 'failed', errorCode: error?.code ?? 'generic' });
      });
    return () => {
      ignore = true;
    };
  }, [version, attempt, getToken, renewToken]);

  async function loadMore() {
    const base = result;
    if (base?.status !== 'ready' || !base.nextCursor || base.loadingMore) return;
    const isBase = (candidate) =>
      candidate?.revision === base.revision && candidate.nextCursor === base.nextCursor;
    setResult((latest) =>
      isBase(latest) ? { ...latest, loadingMore: true, moreErrorCode: null } : latest,
    );
    try {
      const page = await fetchPayments(
        { getToken, renewToken },
        { cursor: base.nextCursor, limit: PAGE_SIZE },
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
              payments: [...latest.payments, ...page.payments],
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

  if (!result) return { status: 'loading', retry, loadMore };
  return { ...result, retry, loadMore };
}
