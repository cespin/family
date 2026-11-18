import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/auth/AuthLayout.jsx';
import { Button } from '../components/ui';
import { useSession } from '../hooks/useSession.js';

export function NotInvitedScreen() {
  const { t } = useTranslation();
  const { signIn } = useSession();
  return (
    <AuthLayout>
      <div className="fa-auth__heading">
        <h2 className="fa-text-heading">{t('auth:notInvited.title')}</h2>
        <p className="fa-text-body fa-text-muted">{t('auth:notInvited.body')}</p>
      </div>
      <Button variant="secondary" size="large" block onClick={signIn}>
        {t('auth:notInvited.button')}
      </Button>
    </AuthLayout>
  );
}
