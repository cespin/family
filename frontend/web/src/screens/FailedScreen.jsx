import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/auth/AuthLayout.jsx';
import { Button, MonkeyBadge } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';

export function FailedScreen() {
  const { t } = useTranslation();
  const { errorCode, retry } = useSession();
  return (
    <AuthLayout>
      <h2 className="fa-text-heading">{t('auth:failed.title')}</h2>
      <div className="fa-auth__alert" role="alert">
        <MonkeyBadge kind="oops">{t('auth:failed.badge')}</MonkeyBadge>
        <p className="fa-text-body">{errorMessage(errorCode)}</p>
      </div>
      <Button variant="secondary" size="large" block onClick={retry}>
        {t('common:actions.retry')}
      </Button>
    </AuthLayout>
  );
}
