import { LogOut, Plus, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button } from '../ui';
import { useSession } from '../../hooks/useSession.js';
import { AppNav } from './AppNav.jsx';
import './AppHeader.css';

export function AppHeader({ wide, showNav, activeTab, onSelectTab, onAdd, onSettings }) {
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
          {onSettings && (
            <Button
              variant="plain"
              iconOnly
              icon={Settings}
              aria-label={t('expenses:settings.open')}
              onClick={onSettings}
            />
          )}
          <Button
            variant="plain"
            iconOnly
            icon={LogOut}
            aria-label={t('common:actions.signOut')}
            onClick={signOut}
          />
          <Avatar
            name={member?.displayName ?? member?.name ?? member?.email ?? ''}
            avatar={member?.avatar}
          />
        </div>
      </div>
    </header>
  );
}
