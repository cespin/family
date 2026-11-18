import { useTranslation } from 'react-i18next';
import { Card, ExpenseRow } from '../ui';
import { formatCalendarDate, formatMinor } from '../../i18n/format.js';
import { expenseStanding, memberById } from '../../lib/ledger.js';

function shareLabel(t, settled, net) {
  if (settled) return { label: t('expenses:row.settled'), labelTone: 'neutral' };
  if (net == null) return { label: t('expenses:row.notInvolved'), labelTone: 'neutral' };
  if (net < 0) return { label: t('expenses:row.youOwe'), labelTone: 'negative' };
  if (net > 0) return { label: t('expenses:row.backToYou'), labelTone: 'positive' };
  return { label: t('expenses:row.even'), labelTone: 'neutral' };
}

export function ExpenseList({ ledger, expenses, onOpen }) {
  const { t } = useTranslation();

  return (
    <Card flush>
      {expenses.map((expense) => {
        const payer = memberById(ledger, expense.payerId);
        const { netMinor: net, settled } = expenseStanding(ledger, expense);
        const details = {
          date: formatCalendarDate(expense.date, { day: 'numeric', month: 'short' }),
          total: formatMinor(expense.amountMinor, expense.currency),
        };
        const hiddenFrom = expense.hiddenFromId && memberById(ledger, expense.hiddenFromId);

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
            hiddenLabel={
              hiddenFrom ? t('expenses:row.hiddenFrom', { name: hiddenFrom.name }) : null
            }
            netMinor={net}
            currency={expense.currency}
            amountTone={settled ? 'muted' : 'auto'}
            {...shareLabel(t, settled, net)}
            onClick={() => onOpen(expense.id)}
          />
        );
      })}
    </Card>
  );
}
