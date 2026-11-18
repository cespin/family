import { Receipt, Users, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../ui';
import './AuthLayout.css';

/** The welcome on the left and, in `children`, whatever the person can do next. */
export function AuthLayout({ children }) {
  const { t } = useTranslation();
  const features = [
    { id: 'currencies', icon: Receipt, tone: 'clay', text: t('auth:hero.currencies') },
    { id: 'split', icon: Users, tone: 'sage', text: t('auth:hero.split') },
    { id: 'settle', icon: Wallet, tone: 'lagoon', text: t('auth:hero.settle') },
  ];

  return (
    <main className="fa-auth">
      <div className="fa-auth__inner">
        <section className="fa-auth__hero">
          <p className="fa-text-brand">{t('common:appName')}</p>
          <h1 className="fa-text-display">{t('auth:hero.title')}</h1>
          <p className="fa-auth__lead fa-text-body fa-text-muted">{t('auth:hero.body')}</p>
          <ul className="fa-auth__features">
            {features.map(({ id, icon: Icon, tone, text }) => (
              <li key={id} className="fa-auth__feature">
                <span className={`fa-auth__badge fa-auth__badge--${tone}`}>
                  <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
                </span>
                <span className="fa-text-body">{text}</span>
              </li>
            ))}
          </ul>
        </section>
        <div className="fa-auth__card">
          <Card>
            <div className="fa-auth__content">{children}</div>
          </Card>
        </div>
      </div>
    </main>
  );
}
