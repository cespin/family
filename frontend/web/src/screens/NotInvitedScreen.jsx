import { MailQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, CenteredPanel } from '../components/ui';
import { useSession } from '../hooks/useSession.js';

export function NotInvitedScreen() {
  const { t } = useTranslation();
  const { signIn } = useSession();
  return (
    <CenteredPanel
      icon={MailQuestion}
      title={t('auth:notInvited.title')}
      body={t('auth:notInvited.body')}
    >
      <Button variant="quiet" onClick={signIn}>
        {t('auth:notInvited.button')}
      </Button>
    </CenteredPanel>
  );
}
