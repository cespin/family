import { useTranslation } from 'react-i18next';
import { Card, ExpenseRow } from '../ui';
import { formatCalendarDate, formatMinor } from '../../i18n/format.js';
import { memberById, transactionDateOf } from '../../lib/ledger.js';

/** What the expense means for me, from the `standing` the API sent with it. */
function shareLabel(t, { involved, openMinor, settled }) {
  if (!involved) return { label: t('expenses:row.notInvolved'), labelTone: 'neutral' };
  if (settled) return { label: t('expenses:row.settled'), labelTone: 'neutral' };
  if (openMinor < 0) return { label: t('expenses:row.youOwe'), labelTone: 'negative' };
  if (openMinor > 0) return { label: t('expenses:row.backToYou'), labelTone: 'positive' };
  return { label: t('expenses:row.even'), labelTone: 'neutral' };
}

export function ExpenseList({ ledger, expenses, onOpen }) {
  const { t } = useTranslation();

  return (
    <Card flush>
      {expenses.map((expense) => {
        const payer = memberById(ledger, expense.payerId);
        const { standing } = expense;
        const details = {
          date: formatCalendarDate(transactionDateOf(expense), { day: 'numeric', month: 'short' }),
          total: formatMinor(expense.amountMinor, expense.currency),
        };
        // A settled expense shows no amount: the API reports nothing left open on it.
        const shownMinor = standing.involved && !standing.settled ? standing.openMinor : null;

        return (
          <ExpenseRow
            key={expense.id}
            payer={payer}
            title={expense.title}
            meta={
              expense.payerId === ledger.me
                ? t('expenses:row.metaYou', details)
                : t('expenses:row.meta', { ...details, name: payer.name })
            }
            netMinor={shownMinor}
            currency={expense.currency}
            {...shareLabel(t, standing)}
            onClick={() => onOpen(expense.id)}
          />
        );
      })}
    </Card>
  );
}
