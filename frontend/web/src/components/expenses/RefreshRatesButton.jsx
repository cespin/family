import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { useSession } from '../../hooks/useSession.js';
import { errorMessage } from '../../i18n/errors.js';
import { refreshExchangeRates } from '../../lib/expenses.js';
import './RefreshRatesButton.css';

/**
 * Asks the backend to fetch the exchange rates from the public services now, and waits for them.
 * Nobody types rates in. `onRefreshed` reloads the ledger, which also picks up rates someone else
 * saved since it was read.
 */
export function RefreshRatesButton({ onRefreshed, variant = 'quiet', size = 'small', block = false }) {
  const { t } = useTranslation();
  const session = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState(null);
  const [errorCode, setErrorCode] = useState(null);

  async function handleClick() {
    if (refreshing) return;
    setRefreshing(true);
    setNote(null);
    setErrorCode(null);
    try {
      const answer = await refreshExchangeRates(session);
      if (!answer?.updated) setNote(t('expenses:rates.upToDate'));
      onRefreshed?.();
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        block={block}
        icon={RefreshCw}
        disabled={refreshing}
        onClick={handleClick}
      >
        {refreshing ? t('expenses:rates.refreshing') : t('expenses:rates.refresh')}
      </Button>
      {note && (
        <p className="fa-refresh-rates__note fa-text-caption fa-text-muted" role="status">
          {note}
        </p>
      )}
      {errorCode && (
        <p className="fa-refresh-rates__note fa-text-caption" role="alert">
          {errorMessage(errorCode)}
        </p>
      )}
    </>
  );
}
