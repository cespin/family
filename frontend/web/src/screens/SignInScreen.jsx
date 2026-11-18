import { House, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, CenteredPanel } from '../components/ui';
import { useSession } from '../hooks/useSession.js';

export function SignInScreen() {
  const { t } = useTranslation();
  const { signIn } = useSession();
  return (
    <CenteredPanel icon={House} title={t('auth:signIn.title')} body={t('auth:signIn.subtitle')}>
      <Button icon={LogIn} onClick={signIn}>
        {t('auth:signIn.button')}
      </Button>
    </CenteredPanel>
  );
}
