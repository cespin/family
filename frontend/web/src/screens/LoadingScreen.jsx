import { useTranslation } from 'react-i18next';
import { CenteredPanel } from '../components/ui';

export function LoadingScreen() {
  const { t } = useTranslation();
  return <CenteredPanel title={t('common:status.loading')} />;
}
