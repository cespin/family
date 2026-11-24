import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyLabel, ratesLine } from '../components/expenses/labels.js';
import { RefreshRatesButton } from '../components/expenses/RefreshRatesButton.jsx';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { AvatarPicker, Button, Card, Segmented, StatusNote } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { AVATARS } from '../lib/avatars.js';
import { saveProfile } from '../lib/expenses.js';
import { myself } from '../lib/ledger.js';
import { CURRENCIES } from '../lib/money.js';
import './SettingsScreen.css';

// ExchangeRate-API's free endpoint asks for a visible link back to it.
const EXCHANGE_RATE_API_URL = 'https://www.exchangerate-api.com';

export function SettingsScreen({ ledger, ledgerState, nav }) {
  const { t } = useTranslation();
  const session = useSession();
  const currencyId = useId();
  const avatarId = useId();
  // The session updates as soon as the save answers, before the ledger reloads.
  const saved = session.member?.homeCurrency ?? myself(ledger).currency;
  const savedAvatar = session.member?.avatar ?? myself(ledger).avatar ?? null;
  const [currency, setCurrency] = useState(saved);
  const [avatar, setAvatar] = useState(savedAvatar);
  const [saving, setSaving] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const [avatarErrorCode, setAvatarErrorCode] = useState(null);
  const [doneNote, setDoneNote] = useState(null);

  const changed = currency !== saved;
  const avatarChanged = avatar != null && avatar !== savedAvatar;

  function handleCurrency(next) {
    setCurrency(next);
    setDoneNote(null);
  }

  function handleAvatar(next) {
    setAvatar(next);
    setDoneNote(null);
  }

  async function handleAvatarSubmit(event) {
    event.preventDefault();
    if (!avatarChanged || savingAvatar) return;
    setSavingAvatar(true);
    setAvatarErrorCode(null);
    try {
      // The route needs the home currency, so this sends the saved one and changes only the avatar.
      session.updateMember(await saveProfile(session, { homeCurrency: saved, avatar }));
      ledgerState.reload();
      setDoneNote(t('expenses:settings.avatarSaved', { avatar }));
    } catch (error) {
      setAvatarErrorCode(error?.code ?? 'generic');
    } finally {
      setSavingAvatar(false);
    }
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

        <Card title={t('expenses:settings.avatarTitle')}>
          <form className="fa-settings" onSubmit={handleAvatarSubmit}>
            <p id={avatarId} className="fa-text-body fa-text-muted">
              {t('expenses:settings.avatarBody')}
            </p>
            <AvatarPicker
              labelledBy={avatarId}
              options={AVATARS}
              value={avatar}
              onChange={handleAvatar}
            />
            {avatarErrorCode && (
              <p className="fa-text-body" role="alert">
                {errorMessage(avatarErrorCode)}
              </p>
            )}
            <Button type="submit" block disabled={!avatarChanged || savingAvatar}>
              {savingAvatar
                ? t('expenses:settings.avatarSaving')
                : t('expenses:settings.avatarSave')}
            </Button>
          </form>
        </Card>

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
            <RefreshRatesButton
              variant="secondary"
              size="medium"
              block
              onRefreshed={ledgerState.reload}
            />
            <p className="fa-text-caption fa-text-muted">{t('expenses:rates.sources')}</p>
            <p className="fa-text-caption">
              <a href={EXCHANGE_RATE_API_URL} target="_blank" rel="noreferrer">
                {t('expenses:rates.attribution')}
              </a>
            </p>
          </div>
        </Card>
      </div>
    </main>
  );
}
