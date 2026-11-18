import { LogOut, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button } from '../ui';
import { useSession } from '../../hooks/useSession.js';
import { AppNav } from './AppNav.jsx';
import './AppHeader.css';

export function AppHeader({ wide, showNav, activeTab, onSelectTab, onAdd }) {
  const { t } = useTranslation();
  const { member, signOut } = useSession();

  return (
    <header className={`fa-app-header${wide ? ' fa-app-header--wide' : ''}`}>
      <div className="fa-app-header__inner">
        <p className="fa-text-brand">{t('common:appName')}</p>
        {wide && showNav && <AppNav wide active={activeTab} onSelect={onSelectTab} />}
        <div className="fa-app-header__actions">
          {wide && showNav && (
            <Button icon={Plus} onClick={onAdd}>
              {t('expenses:nav.add')}
            </Button>
          )}
          <Button
            variant="plain"
            iconOnly
            icon={LogOut}
            aria-label={t('common:actions.signOut')}
            onClick={signOut}
          />
          <Avatar name={member?.name ?? member?.email ?? ''} tone="honey" />
        </div>
      </div>
    </header>
  );
}
