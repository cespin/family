import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BalanceCard } from '../components/expenses/BalanceCard.jsx';
import { ExpenseList } from '../components/expenses/ExpenseList.jsx';
import {
  groupPeople,
  groupsBySize,
  kindFilterLabel,
  usualSplitLabel,
} from '../components/expenses/labels.js';
import { AvatarStack, Button, Card, Chip, EmptyState, MonkeyBadge } from '../components/ui';
import { useSession } from '../hooks/useSession.js';
import { errorMessage } from '../i18n/errors.js';
import { formatCalendarDate, formatDate } from '../i18n/format.js';
import { UNAVAILABLE } from '../lib/expenses.js';
import { ALL_GROUPS, expensesByMonth, filterExpenses, sortedExpenses } from '../lib/ledger.js';
import './HomeScreen.css';

const RECENT_COUNT = 4;
const KIND_FILTERS = ['all', 'meal', 'parents', 'gift', 'other'];

function GroupsCard({ ledger }) {
  const { t } = useTranslation();

  function splitText(group) {
    return group.usual
      ? usualSplitLabel(t, ledger, group)
      : t('expenses:groups.equalAmong', { people: group.memberIds.length });
  }

  return (
    <div id="fa-groups">
      <Card title={t('expenses:groups.title')} subtitle={t('expenses:groups.cardSubtitle')}>
        <ul className="fa-person-list">
          {groupsBySize(ledger).map((group) => (
            <li key={group.id} className="fa-person-row fa-person-row--regular">
              <span className="fa-person-row__main">
                <span className="fa-text-body-strong">{group.name}</span>
                <span className="fa-text-caption fa-text-muted">{splitText(group)}</span>
              </span>
              <AvatarStack people={groupPeople(ledger, group)} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LedgerFailed({ errorCode, onRetry }) {
  const { t } = useTranslation();
  if (errorCode === UNAVAILABLE) {
    return (
      <Card>
        <p className="fa-text-body" role="status">
          {errorMessage(errorCode)}
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <div className="fa-home__failed" role="alert">
        <MonkeyBadge kind="oops">{t('expenses:home.failedBadge')}</MonkeyBadge>
        <p className="fa-text-body">{errorMessage(errorCode)}</p>
        <Button variant="secondary" onClick={onRetry}>
          {t('common:actions.retry')}
        </Button>
      </div>
    </Card>
  );
}

function ExpensesSection({ ledger, groupId, isWide, onOpen }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState('all');
  const [showAll, setShowAll] = useState(false);

  const expenses = sortedExpenses(filterExpenses(ledger.expenses, { groupId, kind }));
  const visible = isWide || showAll ? expenses : expenses.slice(0, RECENT_COUNT);

  const kindChips = (
    <div className="fa-home__chips" role="group" aria-label={t('expenses:filters.kindLabel')}>
      {KIND_FILTERS.map((option) => (
        <Chip key={option} pressed={kind === option} onClick={() => setKind(option)}>
          {kindFilterLabel(t, option)}
        </Chip>
      ))}
    </div>
  );

  return (
    <section id="fa-expenses" className="fa-home__expenses" aria-labelledby="fa-expenses-title">
      <div className="fa-home__section-head">
        <h2 id="fa-expenses-title" className="fa-text-heading">
          {isWide ? t('expenses:home.allTitle') : t('expenses:home.recentTitle')}
        </h2>
        {isWide && kindChips}
        {!isWide && expenses.length > RECENT_COUNT && (
          <Button variant="quiet" size="small" onClick={() => setShowAll((current) => !current)}>
            {showAll ? t('expenses:home.seeLess') : t('expenses:home.seeAll')}
          </Button>
        )}
      </div>
      {!isWide && kindChips}

      {visible.length === 0 && (
        <Card>
          <EmptyState title={t('expenses:home.emptyTitle')}>{t('expenses:home.emptyBody')}</EmptyState>
        </Card>
      )}
      {visible.length > 0 && !isWide && (
        <ExpenseList ledger={ledger} expenses={visible} onOpen={onOpen} />
      )}
      {visible.length > 0 &&
        isWide &&
        expensesByMonth(visible).map((month) => (
          <div key={month.key} className="fa-home__month">
            <h3 className="fa-text-label fa-text-muted fa-text-capitalized">
              {formatCalendarDate(month.date, { month: 'long' })}
            </h3>
            <ExpenseList ledger={ledger} expenses={month.expenses} onOpen={onOpen} />
          </div>
        ))}
    </section>
  );
}

export function HomeScreen({ ledgerState, isWide, nav }) {
  const { t } = useTranslation();
  const { member } = useSession();
  const [groupId, setGroupId] = useState(ALL_GROUPS);
  const [now] = useState(() => new Date());
  const { status, ledger, errorCode, retry } = ledgerState;

  const firstName = member?.name?.split(' ')[0];
  const groupOptions =
    status === 'ready'
      ? [
          { id: ALL_GROUPS, name: t('expenses:filters.allGroups') },
          ...ledger.groups.map(({ id, name }) => ({ id, name })),
        ]
      : [];

  return (
    <main className={`fa-home${isWide ? ' fa-home--wide' : ''}`}>
      <div className="fa-home__top">
        <div className="fa-home__intro">
          <h1 className="fa-text-title">
            {firstName
              ? t('dashboard:greeting', { name: firstName })
              : t('dashboard:greetingFallback')}
          </h1>
          <p className="fa-text-caption fa-text-muted fa-text-capitalized">
            {t('dashboard:today', {
              weekday: formatDate(now, { weekday: 'long' }),
              date: formatDate(now, { day: 'numeric', month: 'long' }),
            })}
          </p>
        </div>
        {status === 'ready' && (
          <div
            className="fa-home__chips fa-home__chips--scroll"
            role="group"
            aria-label={t('expenses:filters.groupLabel')}
          >
            {groupOptions.map((option) => (
              <Chip
                key={option.id}
                pressed={groupId === option.id}
                onClick={() => setGroupId(option.id)}
              >
                {option.name}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {status === 'loading' && (
        <p className="fa-text-body fa-text-muted" role="status">
          {t('common:status.loading')}
        </p>
      )}
      {status === 'failed' && <LedgerFailed errorCode={errorCode} onRetry={retry} />}
      {status === 'ready' && (
        <div className="fa-home__columns">
          <div className="fa-home__rail">
            <BalanceCard ledger={ledger} groupId={groupId} onSettle={nav.settle} />
            {isWide && <GroupsCard ledger={ledger} />}
          </div>
          <ExpensesSection
            ledger={ledger}
            groupId={groupId}
            isWide={isWide}
            onOpen={nav.expense}
          />
        </div>
      )}
    </main>
  );
}
