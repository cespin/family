import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/auth/AuthLayout.jsx';
import { currencyLabel } from '../components/expenses/labels.js';
import { AvatarPicker, Button, Segmented, TextField } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { AVATARS, DEFAULT_AVATAR } from '../lib/avatars.js';
import { saveProfile } from '../lib/expenses.js';
import { CURRENCIES } from '../lib/money.js';
import './ProfileSetupScreen.css';

const NAME_MAX = 40;

/**
 * The first sign-in step: a display name, a home currency and an avatar make the account a family
 * member.
 */
export function ProfileSetupScreen() {
  const { t } = useTranslation();
  const session = useSession();
  const { member, signOut, updateMember } = session;
  const currencyId = useId();
  const avatarId = useId();
  // Starts from the name on the Google account, which may be missing.
  const [name, setName] = useState(member?.name ?? '');
  const [currency, setCurrency] = useState(null);
  const [avatar, setAvatar] = useState(DEFAULT_AVATAR);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState(null);

  const displayName = name.trim();
  const canSave = displayName.length > 0 && currency != null && !saving;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErrorCode(null);
    try {
      updateMember(await saveProfile(session, { displayName, homeCurrency: currency, avatar }));
    } catch (error) {
      setErrorCode(error?.code ?? 'generic');
      setSaving(false);
    }
  }

  return (
    <AuthLayout>
      <form className="fa-profile" onSubmit={handleSubmit}>
        <div className="fa-auth__heading">
          <h2 className="fa-text-heading">{t('auth:profile.title')}</h2>
          <p className="fa-text-body fa-text-muted">{t('auth:profile.body')}</p>
        </div>
        <TextField
          label={t('auth:profile.name')}
          hint={t('auth:profile.nameHint')}
          maxLength={NAME_MAX}
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="fa-profile__question">
          <p id={currencyId} className="fa-text-label">
            {t('auth:profile.currency')}
          </p>
          <Segmented
            labelledBy={currencyId}
            value={currency}
            onChange={setCurrency}
            options={CURRENCIES.map((code) => ({ value: code, label: currencyLabel(t, code) }))}
          />
          <p className="fa-text-caption fa-text-muted">{t('auth:profile.currencyHint')}</p>
        </div>
        <div className="fa-profile__question">
          <p id={avatarId} className="fa-text-label">
            {t('auth:profile.avatar')}
          </p>
          <AvatarPicker
            labelledBy={avatarId}
            options={AVATARS}
            value={avatar}
            onChange={setAvatar}
          />
          <p className="fa-text-caption fa-text-muted">{t('auth:profile.avatarHint')}</p>
        </div>
        {errorCode && (
          <p className="fa-text-body" role="alert">
            {errorMessage(errorCode)}
          </p>
        )}
        <Button type="submit" size="large" block disabled={!canSave}>
          {saving ? t('auth:profile.saving') : t('auth:profile.submit')}
        </Button>
        <Button variant="quiet" block onClick={signOut}>
          {t('common:actions.signOut')}
        </Button>
      </form>
    </AuthLayout>
  );
}
