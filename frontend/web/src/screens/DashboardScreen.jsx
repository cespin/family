import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/expenses/AppHeader.jsx';
import { AppNav } from '../components/expenses/AppNav.jsx';
import { Button, StatusNote } from '../components/ui';
import { useIsWide } from '../hooks/useIsWide.js';
import { useLedger } from '../hooks/useLedger.js';
import { errorMessage } from '../i18n/errors.js';
import { scrollToTop } from '../lib/scroll.js';
import { AddExpenseScreen } from './AddExpenseScreen.jsx';
import { ExchangeRatesScreen } from './ExchangeRatesScreen.jsx';
import { ExpenseDetailScreen } from './ExpenseDetailScreen.jsx';
import { GroupFormScreen } from './GroupFormScreen.jsx';
import { AdvanceScreen } from './AdvanceScreen.jsx';
import { GroupsScreen } from './GroupsScreen.jsx';
import { HomeScreen } from './HomeScreen.jsx';
import { PaymentsScreen } from './PaymentsScreen.jsx';
import { SettingsScreen } from './SettingsScreen.jsx';
import { SettleUpScreen } from './SettleUpScreen.jsx';
import './DashboardScreen.css';

const VIEWS = {
  home: HomeScreen,
  groups: GroupsScreen,
  add: AddExpenseScreen,
  detail: ExpenseDetailScreen,
  settle: SettleUpScreen,
  advance: AdvanceScreen,
  payments: PaymentsScreen,
  group: GroupFormScreen,
  rates: ExchangeRatesScreen,
  settings: SettingsScreen,
};

/** The signed-in app. The app has no router, so the current view is plain state. */
export function DashboardScreen() {
  const { t } = useTranslation();
  // Bumped after every save, so the balances and the expenses on screen reload together.
  const [dataVersion, setDataVersion] = useState(0);
  const ledgerQuery = useLedger(dataVersion);
  const reload = useCallback(() => setDataVersion((current) => current + 1), []);
  const ledgerState = { ...ledgerQuery, reload };
  const isWide = useIsWide();
  const [view, setView] = useState({ name: 'home', tab: 'balances' });
  const contentRef = useRef(null);
  const shownView = useRef(view);

  // A new view replaces the whole screen, so focus and scroll have to follow it.
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    contentRef.current?.focus({ preventScroll: true });
    const section = view.section ? document.getElementById(view.section) : null;
    if (section) section.scrollIntoView?.();
    else scrollToTop();
  }, [view]);

  const ready = ledgerState.status === 'ready';
  const canAdd = ready && ledgerState.ledger.groups.length > 0;
  const name = ready ? view.name : 'home';
  const Screen = VIEWS[name];
  const isTabView = name === 'home' || name === 'groups';

  const nav = {
    home: () => setView({ name: 'home', tab: 'balances' }),
    add: () => setView({ name: 'add' }),
    edit: (expenseId) => setView({ name: 'add', expenseId }),
    expense: (expenseId) => setView({ name: 'detail', expenseId }),
    settle: (memberId) => setView({ name: 'settle', memberId }),
    advance: () => setView({ name: 'advance' }),
    payments: () => setView({ name: 'payments' }),
    groups: () =>
      isWide
        ? setView({ name: 'home', tab: 'groups', section: 'fa-groups' })
        : setView({ name: 'groups', tab: 'groups' }),
    newGroup: () => setView({ name: 'group' }),
    editGroup: (groupId) => setView({ name: 'group', groupId }),
    rates: () => setView({ name: 'rates' }),
    settings: () => setView({ name: 'settings' }),
  };

  function handleSelectTab(tab) {
    if (tab === 'expenses') setView({ name: 'home', tab, section: 'fa-expenses' });
    else if (tab !== 'groups') setView({ name: 'home', tab });
    else if (isWide) setView({ name: 'home', tab, section: 'fa-groups' });
    else setView({ name: 'groups', tab });
  }

  return (
    <div className="fa-shell">
      {(isWide || name === 'home') && (
        <AppHeader
          wide={isWide}
          showNav={canAdd}
          activeTab={view.tab}
          onSelectTab={handleSelectTab}
          onAdd={nav.add}
          onSettings={ready ? nav.settings : undefined}
        />
      )}
      <div
        ref={contentRef}
        tabIndex={-1}
        className={`fa-shell__content${isWide && name === 'home' ? ' fa-shell__content--wide' : ''}`}
      >
        {ledgerState.refreshErrorCode && (
          <div className="fa-shell__stale">
            <StatusNote tone="warning">
              {t('expenses:home.stale', { reason: errorMessage(ledgerState.refreshErrorCode) })}
            </StatusNote>
            <Button variant="quiet" size="small" onClick={reload}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        <Screen
          key={`${name}:${view.expenseId ?? view.memberId ?? view.groupId ?? ''}`}
          ledger={ledgerState.ledger}
          ledgerState={ledgerState}
          dataVersion={dataVersion}
          view={view}
          isWide={isWide}
          nav={nav}
        />
      </div>
      {!isWide && ready && isTabView && (
        <div className="fa-shell__dock">
          <div className="fa-shell__dock-inner">
            {name === 'home' && canAdd && (
              <Button size="large" block icon={Plus} onClick={nav.add}>
                {t('expenses:nav.add')}
              </Button>
            )}
            <AppNav active={view.tab} onSelect={handleSelectTab} />
          </div>
        </div>
      )}
    </div>
  );
}
