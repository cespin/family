import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ratesQuotes } from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { Button, Card, StatusNote, TextField } from '../components/ui';
import { useRequestId } from '../hooks/useRequestId.js';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { formatCalendarDate, formatNumber } from '../i18n/format.js';
import { saveExchangeRates } from '../lib/expenses.js';
import { memberById, todayIso } from '../lib/ledger.js';
import { parseRate } from '../lib/money.js';
import './ExchangeRatesScreen.css';

// A new rate this far from the last one is more likely a typo than a market move.
const BIG_CHANGE = 0.2;

function isBigChange(next, previous) {
  return next != null && previous != null && Math.abs(Number(next) / Number(previous) - 1) > BIG_CHANGE;
}

function CurrentRates({ ledger }) {
  const { t } = useTranslation();
  const { rates } = ledger;
  if (!rates) {
    return (
      <Card>
        <p className="fa-text-body">{t('expenses:ratesScreen.none')}</p>
      </Card>
    );
  }
  const enteredBy = memberById(ledger, rates.enteredBy);
  const date = formatCalendarDate(rates.asOf, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Card title={t('expenses:ratesScreen.currentTitle')}>
      <div className="fa-rates">
        <p className="fa-text-body-strong">{ratesQuotes(t, rates)}</p>
        <p className="fa-text-caption fa-text-muted">
          {rates.enteredBy === ledger.me
            ? t('expenses:ratesScreen.enteredByYou', { date })
            : t('expenses:ratesScreen.enteredBy', { date, name: enteredBy?.name })}
        </p>
      </div>
    </Card>
  );
}

/** See the rates in use and enter new ones. Any member can enter them. */
export function ExchangeRatesScreen({ ledger, ledgerState, nav }) {
  const { t } = useTranslation();
  const session = useSession();
  const { prepare, done } = useRequestId();
  const [usdCadText, setUsdCadText] = useState('');
  const [cadClpText, setCadClpText] = useState('');
  // The values the person already confirmed despite a big change.
  const [confirmed, setConfirmed] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const [doneNote, setDoneNote] = useState(null);

  const current = ledger.rates;
  const usdCad = parseRate(usdCadText);
  const cadClp = parseRate(cadClpText);
  const ready = usdCad != null && cadClp != null;
  const values = `${usdCad}|${cadClp}`;
  const bigChange =
    ready && (isBigChange(usdCad, current?.usdCad) || isBigChange(cadClp, current?.cadClp));
  const asking = bigChange && confirmed === values;

  function edit(setter) {
    return (event) => {
      setter(event.target.value);
      setDoneNote(null);
    };
  }

  function submitLabel() {
    if (saving) return t('expenses:ratesScreen.saving');
    if (!ready) return t('expenses:ratesScreen.needRates');
    return asking ? t('expenses:ratesScreen.confirm') : t('expenses:ratesScreen.save');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready || saving) return;
    if (bigChange && !asking) {
      setConfirmed(values);
      return;
    }
    setSaving(true);
    setErrorCode(null);
    const body = { usdCad, cadClp, date: todayIso() };
    try {
      await saveExchangeRates(session, prepare(body));
      done();
      ledgerState.reload();
      setUsdCadText('');
      setCadClpText('');
      setConfirmed(null);
      setDoneNote(t('expenses:ratesScreen.saved'));
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <SubHeader backLabel={t('expenses:ratesScreen.back')} onBack={nav.home} />
      <div className="fa-screen">
        <div className="fa-screen__intro">
          <h1 className="fa-text-title">{t('expenses:ratesScreen.title')}</h1>
          <p className="fa-text-body fa-text-muted">{t('expenses:ratesScreen.intro')}</p>
        </div>

        {doneNote && <StatusNote>{doneNote}</StatusNote>}
        <CurrentRates ledger={ledger} />

        <Card title={t('expenses:ratesScreen.newTitle')}>
          <form className="fa-rates" onSubmit={handleSubmit}>
            <TextField
              label={t('expenses:ratesScreen.usdCad')}
              inputMode="decimal"
              placeholder={current ? formatNumber(Number(current.usdCad)) : undefined}
              value={usdCadText}
              onChange={edit(setUsdCadText)}
            />
            <TextField
              label={t('expenses:ratesScreen.cadClp')}
              inputMode="decimal"
              placeholder={current ? formatNumber(Number(current.cadClp)) : undefined}
              value={cadClpText}
              onChange={edit(setCadClpText)}
            />
            {asking && (
              <StatusNote tone="warning" strong>
                {t('expenses:ratesScreen.bigChange')}
              </StatusNote>
            )}
            {errorCode && (
              <p className="fa-text-body" role="alert">
                {errorMessage(errorCode)}
              </p>
            )}
            <Button type="submit" size="large" block disabled={!ready || saving}>
              {submitLabel()}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
