import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, CenteredPanel } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';

export function FailedScreen() {
  const { t } = useTranslation();
  const { errorCode, retry } = useSession();
  return (
    <CenteredPanel
      icon={TriangleAlert}
      title={t('auth:failed.title')}
      body={errorMessage(errorCode)}
    >
      <Button variant="quiet" onClick={retry}>
        {t('common:actions.retry')}
      </Button>
    </CenteredPanel>
  );
}
