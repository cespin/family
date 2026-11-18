import { Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  currencyLabel,
  kindLabel,
  memberLabel,
  percentLabel,
  quoteLabel,
} from '../components/expenses/labels.js';
import { SubHeader } from '../components/expenses/SubHeader.jsx';
import { Amount, Avatar, Button, Card, PersonRow, SplitBar, StatusNote } from '../components/ui';
import { errorMessage } from '../i18n/errors.js';
import { formatCalendarDate, formatMinor } from '../i18n/format.js';
import {
  expenseById,
  expenseNet,
  expenseStanding,
  groupById,
  memberById,
  pairCleared,
  sharePercent,
} from '../lib/ledger.js';
import { convertMinor, quoteBetween } from '../lib/money.js';
import './ExpenseDetailScreen.css';

const SHORT_DATE = { day: 'numeric', month: 'short' };

function participantStatus(t, ledger, expense, standing, id) {
  const payer = memberById(ledger, expense.payerId);
  const total = formatMinor(expense.amountMinor, expense.currency);
  const payment = expense.payments?.find((item) => item.fromId === id);

  if (expense.settled) return { text: t('expenses:detail.status.settled'), tone: 'muted' };
  if (id === expense.payerId) {
    const text =
      id === ledger.me
        ? t('expenses:detail.status.youPaidAll', { amount: total })
        : t('expenses:detail.status.paidAll', { amount: total });
    return { text, tone: 'muted' };
  }
  const paidOff =
    (id === ledger.me && standing.settled) ||
    (expense.payerId === ledger.me && pairCleared(ledger, expense, id));
  if (paidOff) return { text: t('expenses:detail.status.settled'), tone: 'muted' };
  if (payment) {
    const amount = formatMinor(payment.amountMinor, payment.currency);
    return { text: t('expenses:detail.status.paid', { amount }), tone: 'positive' };
  }
  if (id === ledger.me) {
    return { text: t('expenses:detail.status.youOwe', { name: payer.name }), tone: 'negative' };
  }
  if (expense.payerId === ledger.me) {
    return { text: t('expenses:detail.status.owesYou'), tone: 'muted' };
  }
  return { text: t('expenses:detail.status.owes', { name: payer.name }), tone: 'muted' };
}

function activityOf(t, ledger, expense) {
  const { me } = ledger;
  const payments = (expense.payments ?? []).map((payment) => {
    const amount = formatMinor(payment.amountMinor, payment.currency);
    const from = memberById(ledger, payment.fromId);
    const to = memberById(ledger, payment.toId);
    let text;
    if (payment.fromId === me) text = t('expenses:detail.activityYouPaid', { amount, to: to.name });
    else if (payment.toId === me) text = t('expenses:detail.activityPaidYou', { amount, from: from.name });
    else if (payment.coversMinor != null) {
      text = t('expenses:detail.activityPaidCovers', {
        amount,
        from: from.name,
        to: to.name,
        covers: formatMinor(payment.coversMinor, expense.currency),
      });
    } else text = t('expenses:detail.activityPaid', { amount, from: from.name, to: to.name });
    return { id: payment.id, person: from, text, date: payment.date };
  });

  const adder = memberById(ledger, expense.addedById ?? expense.payerId);
  const added = {
    id: 'added',
    person: adder,
    text:
      adder.id === me
        ? t('expenses:detail.activityAddedYou')
        : t('expenses:detail.activityAdded', { name: adder.name }),
    date: expense.date,
  };
  return [...payments, added].sort((a, b) => b.date.localeCompare(a.date));
}

function splitSubtitle(t, expense, group) {
  if (expense.splitMode !== 'percent') return t('expenses:detail.splitEqual');
  const isUsual =
    group.usual && group.memberIds.every((id) => group.usual[id] === expense.percents?.[id]);
  return isUsual ? t('expenses:detail.splitUsual') : t('expenses:detail.splitPercent');
}

export function ExpenseDetailScreen({ ledger, view, nav }) {
  const { t } = useTranslation();
  const expense = expenseById(ledger, view.expenseId);

  if (!expense) {
    return (
      <main>
        <SubHeader backLabel={t('expenses:detail.back')} onBack={nav.home} />
        <div className="fa-screen">
          <p className="fa-text-body" role="alert">
            {errorMessage('not_found')}
          </p>
        </div>
      </main>
    );
  }

  const { me } = ledger;
  const group = groupById(ledger, expense.groupId);
  const payer = memberById(ledger, expense.payerId);
  const myCurrency = memberById(ledger, me).currency;
  const rates = expense.rates ?? ledger.rates;
  const standing = expenseStanding(ledger, expense);
  const net = standing.netMinor;
  const gross = expenseNet(expense, me);
  const participants = group.memberIds.filter((id) => expense.shares[id] != null);
  const longDate = formatCalendarDate(expense.date, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const converted = convertMinor(expense.amountMinor, expense.currency, myCurrency, rates);
  const quote = quoteBetween(expense.currency, myCurrency, rates);
  const myPercent = expense.shares[me] != null ? percentLabel(t, sharePercent(expense, me)) : null;
  const myNetConverted =
    net == null ? null : convertMinor(net, expense.currency, myCurrency, rates);
  const showsConversion = expense.currency !== myCurrency && myNetConverted != null;
  const isOpen = !standing.settled && net != null && net !== 0;
  const paidSoFar = isOpen && gross != null ? Math.abs(gross) - Math.abs(net) : 0;

  return (
    <main>
      <SubHeader
        backLabel={t('expenses:detail.back')}
        onBack={nav.home}
        action={
          <Button variant="quiet" size="small" onClick={() => nav.edit(expense.id)}>
            {t('expenses:detail.edit')}
          </Button>
        }
      />
      <div className="fa-screen">
        <div className="fa-detail__intro">
          <p className="fa-text-caption fa-text-muted">
            {t('expenses:detail.context', {
              kind: kindLabel(t, expense.kind),
              group: group.name,
            })}
          </p>
          <h1 className="fa-text-title">{expense.title}</h1>
          <p className="fa-detail__total">
            <Amount
              minor={expense.amountMinor}
              currency={expense.currency}
              tone="neutral"
            />
          </p>
          {expense.currency !== myCurrency && converted != null && quote && (
            <p className="fa-text-caption fa-text-muted">
              {t('expenses:detail.converted', {
                amount: formatMinor(converted, myCurrency),
                date: formatCalendarDate(rates.asOf ?? expense.date, SHORT_DATE),
                rate: quoteLabel(t, quote),
              })}
            </p>
          )}
          <p className="fa-detail__line fa-text-body fa-text-muted">
            {expense.payerId === me
              ? t('expenses:detail.paidByYou', { date: longDate })
              : t('expenses:detail.paidBy', { name: payer.name, date: longDate })}
          </p>
          {expense.note && (
            <p className="fa-detail__line fa-detail__note fa-text-body">
              {t('expenses:detail.note', { note: expense.note })}
            </p>
          )}
        </div>

        {standing.settled && <StatusNote>{t('expenses:detail.settled')}</StatusNote>}

        {isOpen && (
          <Card>
            <div className="fa-detail__owed">
              <div className="fa-detail__owed-row">
                <Avatar
                  name={net < 0 ? payer.name : memberById(ledger, me).name}
                  tone={net < 0 ? payer.tone : memberById(ledger, me).tone}
                />
                <div className="fa-detail__owed-text">
                  <span className="fa-text-body-strong">
                    {net < 0
                      ? t('expenses:detail.youOwe', { name: payer.name })
                      : t('expenses:detail.backToYou')}
                  </span>
                  {myPercent && (
                    <span className="fa-text-caption fa-text-muted">
                      {showsConversion
                        ? t('expenses:detail.yourShare', {
                            percent: myPercent,
                            amount: t('expenses:approx', {
                              amount: formatMinor(myNetConverted, myCurrency),
                            }),
                          })
                        : t('expenses:detail.yourShareExact', { percent: myPercent })}
                    </span>
                  )}
                  {paidSoFar > 0 && (
                    <span className="fa-text-caption fa-text-muted">
                      {t('expenses:detail.paidSoFar', {
                        amount: formatMinor(paidSoFar, expense.currency),
                      })}
                    </span>
                  )}
                </div>
                <Amount minor={net} currency={expense.currency} />
              </div>
              {net < 0 && (
                <Button
                  size="large"
                  block
                  icon={Wallet}
                  onClick={() => nav.settle(expense.payerId)}
                >
                  {t('expenses:detail.settleWith', { name: payer.name })}
                </Button>
              )}
            </div>
          </Card>
        )}

        <Card title={t('expenses:detail.splitTitle')} subtitle={splitSubtitle(t, expense, group)}>
          <div className="fa-detail__split">
            <SplitBar
              label={participants
                .map(
                  (id) =>
                    `${memberLabel(t, ledger, id)} ${percentLabel(t, sharePercent(expense, id))}`,
                )
                .join(', ')}
              parts={participants.map((id) => {
                const person = memberById(ledger, id);
                return {
                  id,
                  name: person.name,
                  tone: person.tone,
                  percent: sharePercent(expense, id),
                };
              })}
            />
            <ul className="fa-person-list">
              {participants.map((id) => {
                const person = memberById(ledger, id);
                const status = participantStatus(t, ledger, expense, standing, id);
                const details = {
                  percent: percentLabel(t, sharePercent(expense, id)),
                  currency: currencyLabel(t, person.currency),
                };
                return (
                  <PersonRow
                    key={id}
                    person={person}
                    avatarSize="small"
                    density="medium"
                    title={memberLabel(t, ledger, id)}
                    subtitle={
                      id === me
                        ? t('expenses:detail.usesYou', details)
                        : t('expenses:detail.uses', details)
                    }
                    trailing={
                      <span className="fa-detail__share">
                        <Amount
                          minor={expense.shares[id]}
                          currency={expense.currency}
                          size="small"
                          tone="neutral"
                        />
                        <span className={`fa-text-caption fa-detail__status--${status.tone}`}>
                          {status.text}
                        </span>
                      </span>
                    }
                  />
                );
              })}
            </ul>
          </div>
        </Card>

        <section className="fa-screen__section" aria-labelledby="fa-activity-title">
          <h2 id="fa-activity-title" className="fa-text-heading">
            {t('expenses:detail.activity')}
          </h2>
          <ul className="fa-detail__activity">
            {activityOf(t, ledger, expense).map((item) => (
              <li key={item.id} className="fa-detail__activity-item">
                <Avatar name={item.person.name} tone={item.person.tone} size="small" />
                <span className="fa-detail__activity-text fa-text-body">{item.text}</span>
                <span className="fa-text-caption fa-text-muted">
                  {formatCalendarDate(item.date, SHORT_DATE)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
