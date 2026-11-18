import { Receipt, Users, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './AppNav.css';

const TABS = [
  { id: 'balances', icon: Wallet },
  { id: 'expenses', icon: Receipt },
  { id: 'groups', icon: Users },
];

export function AppNav({ active, wide, onSelect }) {
  const { t } = useTranslation();
  const labels = {
    balances: t('expenses:nav.balances'),
    expenses: t('expenses:nav.expenses'),
    groups: t('expenses:nav.groups'),
  };

  return (
    <nav aria-label={t('expenses:nav.label')} className={`fa-nav fa-nav--${wide ? 'wide' : 'tabs'}`}>
      {TABS.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className="fa-nav__item"
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          <span className="fa-nav__icon">
            <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
          </span>
          <span className="fa-nav__label">{labels[id]}</span>
        </button>
      ))}
    </nav>
  );
}
