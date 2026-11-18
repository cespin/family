import { LogOut, Sprout } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import './DashboardScreen.css';

export function DashboardScreen() {
  const { t } = useTranslation();
  const { member, signOut } = useSession();
  const firstName = member?.name?.split(' ')[0];

  return (
    <div className="fa-dashboard">
      <header className="fa-dashboard__header">
        <span className="fa-dashboard__brand">{t('common:appName')}</span>
        <Button variant="quiet" icon={LogOut} onClick={signOut}>
          {t('common:actions.signOut')}
        </Button>
      </header>
      <main className="fa-dashboard__main">
        <h1 className="fa-dashboard__greeting">
          {firstName
            ? t('dashboard:greeting', { name: firstName })
            : t('dashboard:greetingFallback')}
        </h1>
        <section className="fa-dashboard__empty">
          <Sprout aria-hidden="true" size={28} />
          <h2 className="fa-dashboard__empty-title">{t('dashboard:empty.title')}</h2>
          <p className="fa-dashboard__empty-body">{t('dashboard:empty.body')}</p>
        </section>
      </main>
    </div>
  );
}
