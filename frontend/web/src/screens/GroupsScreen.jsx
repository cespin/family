import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  currencyLabel,
  groupPeople,
  groupsBySize,
  memberLabel,
  percentLabel,
} from '../components/expenses/labels.js';
import { Amount, AvatarStack, Button, Card, PersonRow, SplitBar } from '../components/ui';
import { balanceTotal, myself } from '../lib/ledger.js';
import './GroupsScreen.css';

const ALL_FACES_UP_TO = 5;

function balanceText(t, total) {
  if (total == null) return t('expenses:groups.incomplete');
  if (total > 0) return t('expenses:groups.owedToYou');
  return total < 0 ? t('expenses:groups.youOwe') : t('expenses:groups.even');
}

function GroupCard({ ledger, group, onEdit }) {
  const { t } = useTranslation();
  const people = groupPeople(ledger, group);
  const { currency } = myself(ledger);
  const total = balanceTotal(ledger, { groupId: group.id, currency, withUngrouped: true });
  const currencies = new Set(people.map((person) => person.currency)).size;
  const split = group.usual ? t('expenses:groups.byPercent') : t('expenses:groups.equalParts');
  const summary =
    currencies === 1
      ? t('expenses:groups.summaryOneCurrency', { people: people.length, split })
      : t('expenses:groups.summary', { people: people.length, currencies, split });

  return (
    <Card title={group.name} subtitle={summary}>
      <div className="fa-group">
        {group.usual ? (
          <>
            <SplitBar
              label={people
                .map(
                  (person) =>
                    `${memberLabel(t, ledger, person.id)} ${percentLabel(t, group.usual[person.id])}`,
                )
                .join(', ')}
              parts={people.map((person) => ({
                id: person.id,
                name: person.name,
                tone: person.tone,
                percent: group.usual[person.id],
              }))}
            />
            <ul className="fa-person-list">
              {people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  avatarSize="small"
                  density="compact"
                  title={memberLabel(t, ledger, person.id)}
                  trailing={
                    <>
                      <span className="fa-text-caption fa-text-muted">
                        {currencyLabel(t, person.currency)}
                      </span>
                      <span className="fa-group__percent fa-text-label">
                        {percentLabel(t, group.usual[person.id])}
                      </span>
                    </>
                  }
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="fa-group__people">
            <AvatarStack
              people={people}
              size="medium"
              max={people.length <= ALL_FACES_UP_TO ? ALL_FACES_UP_TO : undefined}
            />
          </div>
        )}
        <div className="fa-group__balance">
          <span className="fa-text-body">{balanceText(t, total)}</span>
          <Amount minor={total} currency={currency} size="small" />
        </div>
        {group.createdBy === ledger.me && (
          <Button
            variant="quiet"
            size="small"
            aria-label={t('expenses:groups.editNamed', { group: group.name })}
            onClick={() => onEdit(group.id)}
          >
            {t('expenses:groups.edit')}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function GroupsScreen({ ledger, nav }) {
  const { t } = useTranslation();
  return (
    <main className="fa-screen fa-groups">
      <div className="fa-screen__intro">
        <h1 className="fa-text-title">{t('expenses:groups.title')}</h1>
        <p className="fa-text-body fa-text-muted">{t('expenses:groups.intro')}</p>
      </div>
      <Button variant="secondary" block icon={Plus} onClick={nav.newGroup}>
        {t('expenses:groups.new')}
      </Button>
      {groupsBySize(ledger).map((group) => (
        <GroupCard key={group.id} ledger={ledger} group={group} onEdit={nav.editGroup} />
      ))}
    </main>
  );
}
