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
import { useExpense } from '../hooks/useExpense.js';
import { errorMessage } from '../i18n/errors.js';
import { formatCalendarDate, formatMinor } from '../i18n/format.js';
import { groupById, memberById, myself, ratesById, sharePercent } from '../lib/ledger.js';
import { convertMinor, quoteBetween } from '../lib/money.js';
import './ExpenseDetailScreen.css';

const SHORT_DATE = { day: 'numeric', month: 'short' };

/** Each participant's status comes from the API: `owes`, `partly_paid` or `paid`. */
function participantStatus(t, ledger, expense, participant) {
  const { memberId: id, status } = participant;
  const payer = memberById(ledger, expense.payerId);
  const total = formatMinor(expense.amountMinor, expense.currency);

  if (id === expense.payerId) {
    const text =
      id === ledger.me
        ? t('expenses:detail.status.youPaidAll', { amount: total })
        : t('expenses:detail.status.paidAll', { amount: total });
    return { text, tone: 'muted' };
  }
  if (status === 'paid') return { text: t('expenses:detail.status.settled'), tone: 'muted' };
  if (status === 'partly_paid') {
    return { text: t('expenses:detail.status.partlyPaid'), tone: 'positive' };
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
  const payments = expense.appliedPayments.map((payment, index) => {
    const paid = formatMinor(payment.paidMinor, payment.paidCurrency);
    const amount =
      payment.paidCurrency === expense.currency
        ? paid
        : t('expenses:detail.amountCovers', {
            paid,
            covered: formatMinor(payment.coveredMinor, expense.currency),
          });
    const from = memberById(ledger, payment.fromId);
    const to = memberById(ledger, payment.toId);
    let text;
    if (payment.fromId === me) text = t('expenses:detail.activityYouPaid', { amount, to: to.name });
    else if (payment.toId === me) {
      text = t('expenses:detail.activityPaidYou', { amount, from: from.name });
    } else text = t('expenses:detail.activityPaid', { amount, from: from.name, to: to.name });
    // Credit from one payment can reach the same expense more than once, so the id alone is not
    // unique. The list never reorders.
    return { id: `${payment.paymentId}:${index}`, person: from, text, date: payment.date };
  });

  const adder = memberById(ledger, expense.addedBy);
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

function splitSubtitle(t, ledger, expense, group) {
  if (expense.splitMode !== 'percent') {
    // One participant is how "I pay all" is stored: an equal split among one person.
    const only = expense.participants.length === 1 ? expense.participants[0].memberId : null;
    if (only === ledger.me) return t('expenses:detail.splitSingleYou');
    const name = only && memberById(ledger, only)?.name;
    return name ? t('expenses:detail.splitSingle', { name }) : t('expenses:detail.splitEqual');
  }
  const isUsual =
    group.usual &&
    group.memberIds.every(
      (id) =>
        (group.usual[id] ?? 0) ===
        (expense.participants.find((item) => item.memberId === id)?.percent ?? 0),
    );
  return isUsual ? t('expenses:detail.splitUsual') : t('expenses:detail.splitPercent');
}

/** What the caller's side of the expense came to before any payment. */
function grossFor(expense, me) {
  const mine = expense.participants.find((participant) => participant.memberId === me);
  if (expense.payerId === me) return expense.amountMinor - (mine?.shareMinor ?? 0);
  return mine ? -mine.shareMinor : null;
}

export function ExpenseDetailScreen({ ledger, view, nav, dataVersion }) {
  const { t } = useTranslation();
  const query = useExpense(view.expenseId, dataVersion);

  if (query.status !== 'ready') {
    return (
      <main>
        <SubHeader backLabel={t('expenses:detail.back')} onBack={nav.home} />
        <div className="fa-screen">
          {query.status === 'loading' ? (
            <p className="fa-text-body fa-text-muted" role="status">
              {t('common:status.loading')}
            </p>
          ) : (
            <>
              <p className="fa-text-body" role="alert">
                {errorMessage(query.errorCode)}
              </p>
              {query.errorCode !== 'not_found' && (
                <Button variant="secondary" onClick={query.retry}>
                  {t('common:actions.retry')}
                </Button>
              )}
            </>
          )}
        </div>
      </main>
    );
  }
  return <ExpenseDetail ledger={ledger} expense={query.expense} nav={nav} />;
}

function ExpenseDetail({ ledger, expense, nav }) {
  const { t } = useTranslation();
  const { me } = ledger;
  const group = groupById(ledger, expense.groupId);
  const payer = memberById(ledger, expense.payerId);
  const caller = myself(ledger);
  const myCurrency = caller.currency;
  const rates = ratesById(ledger, expense.ratesId);
  const { standing } = expense;
  const net = standing.involved ? standing.openMinor : null;
  const gross = grossFor(expense, me);
  const mine = expense.participants.find((participant) => participant.memberId === me);
  const longDate = formatCalendarDate(expense.date, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const converted = convertMinor(expense.amountMinor, expense.currency, myCurrency, rates);
  const quote = quoteBetween(expense.currency, myCurrency, rates);
  const myPercent = mine ? percentLabel(t, sharePercent(expense, mine)) : null;
  const myNetConverted =
    net == null ? null : convertMinor(net, expense.currency, myCurrency, rates);
  const showsConversion = expense.currency !== myCurrency && myNetConverted != null;
  const isOpen = !standing.settled && net != null && net !== 0;
  const paidSoFar = isOpen && gross != null ? Math.abs(gross) - Math.abs(net) : 0;
  const charged = expense.otherAmount
    ? expense.chargedCurrency === expense.currency
      ? { minor: expense.amountMinor, currency: expense.currency }
      : { minor: expense.otherAmount.amountMinor, currency: expense.otherAmount.currency }
    : null;
  const receipt = expense.otherAmount
    ? expense.chargedCurrency === expense.currency
      ? { minor: expense.otherAmount.amountMinor, currency: expense.otherAmount.currency }
      : { minor: expense.amountMinor, currency: expense.currency }
    : null;

  return (
    <main>
      <SubHeader
        backLabel={t('expenses:detail.back')}
        onBack={nav.home}
        action={
          expense.addedBy === me && (
            <Button variant="quiet" size="small" onClick={() => nav.edit(expense.id)}>
              {t('expenses:detail.edit')}
            </Button>
          )
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
                date: formatCalendarDate(rates.asOf, SHORT_DATE),
                rate: quoteLabel(t, quote),
              })}
            </p>
          )}
          {charged && (
            <p className="fa-text-caption fa-text-muted">
              {t('expenses:detail.twoAmounts', {
                receipt: formatMinor(receipt.minor, receipt.currency),
                charged: formatMinor(charged.minor, charged.currency),
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
                  name={net < 0 ? payer.name : caller.name}
                  tone={net < 0 ? payer.tone : caller.tone}
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

        <Card title={t('expenses:detail.splitTitle')} subtitle={splitSubtitle(t, ledger, expense, group)}>
          <div className="fa-detail__split">
            <SplitBar
              label={expense.participants
                .map(
                  (participant) =>
                    `${memberLabel(t, ledger, participant.memberId)} ${percentLabel(
                      t,
                      sharePercent(expense, participant),
                    )}`,
                )
                .join(', ')}
              parts={expense.participants.map((participant) => {
                const person = memberById(ledger, participant.memberId);
                return {
                  id: participant.memberId,
                  name: person.name,
                  tone: person.tone,
                  percent: sharePercent(expense, participant),
                };
              })}
            />
            <ul className="fa-person-list">
              {expense.participants.map((participant) => {
                const id = participant.memberId;
                const person = memberById(ledger, id);
                const status = participantStatus(t, ledger, expense, participant);
                const details = {
                  percent: percentLabel(t, sharePercent(expense, participant)),
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
                          minor={participant.shareMinor}
                          currency={expense.currency}
                          size="small"
                          tone="neutral"
                        />
                        {participant.otherShareMinor != null && (
                          <span className="fa-text-caption fa-text-muted">
                            {t('expenses:approx', {
                              amount: formatMinor(
                                participant.otherShareMinor,
                                expense.otherAmount.currency,
                              ),
                            })}
                          </span>
                        )}
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
