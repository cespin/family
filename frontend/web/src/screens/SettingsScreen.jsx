import { useId, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currencyLabel, ratesLine } from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { Button, Card, Segmented, StatusNote } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { saveProfile } from '../lib/expenses.js';
import { myself } from '../lib/ledger.js';
import { CURRENCIES } from '../lib/money.js';
import './SettingsScreen.css';

export function SettingsScreen({ ledger, ledgerState, nav }) {
  const { t } = useTranslation();
  const session = useSession();
  const currencyId = useId();
  // The session updates as soon as the save answers, before the ledger reloads.
  const saved = session.member?.homeCurrency ?? myself(ledger).currency;
  const [currency, setCurrency] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const [doneNote, setDoneNote] = useState(null);

  const changed = currency !== saved;

  function handleCurrency(next) {
    setCurrency(next);
    setDoneNote(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setErrorCode(null);
    try {
      session.updateMember(await saveProfile(session, { homeCurrency: currency }));
      ledgerState.reload();
      setDoneNote(t('expenses:settings.saved', { currency: currencyLabel(t, currency) }));
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <SubHeader backLabel={t('expenses:settings.back')} onBack={nav.home} />
      <div className="fa-screen">
        <div className="fa-screen__intro">
          <h1 className="fa-text-title">{t('expenses:settings.title')}</h1>
        </div>

        {doneNote && <StatusNote>{doneNote}</StatusNote>}

        <Card title={t('expenses:settings.currencyTitle')}>
          <form className="fa-settings" onSubmit={handleSubmit}>
            <p id={currencyId} className="fa-text-body fa-text-muted">
              {t('expenses:settings.currencyBody')}
            </p>
            <Segmented
              labelledBy={currencyId}
              value={currency}
              onChange={handleCurrency}
              options={CURRENCIES.map((code) => ({ value: code, label: currencyLabel(t, code) }))}
            />
            {errorCode && (
              <p className="fa-text-body" role="alert">
                {errorMessage(errorCode)}
              </p>
            )}
            <Button type="submit" block disabled={!changed || saving}>
              {saving ? t('expenses:settings.saving') : t('expenses:settings.save')}
            </Button>
          </form>
        </Card>

        <Card title={t('expenses:settings.ratesTitle')}>
          <div className="fa-settings">
            <p className="fa-text-body fa-text-muted">
              {ratesLine(t, ledger) ?? t('expenses:rates.none')}
            </p>
            <Button variant="secondary" block icon={ArrowLeftRight} onClick={nav.rates}>
              {t('expenses:rates.open')}
            </Button>
          </div>
        </Card>
      </div>
    </main>
  );
}
