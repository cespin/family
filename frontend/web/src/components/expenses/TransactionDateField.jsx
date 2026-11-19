import { useTranslation } from 'react-i18next';
import { TextField } from '../ui';
import { todayIso } from '../../lib/ledger.js';

/** The day the money was spent or given. Any past day, never a future one. */
export function TransactionDateField({ value, onChange }) {
  const { t } = useTranslation();
  return (
    <TextField
      type="date"
      label={t('expenses:when.label')}
      hint={t('expenses:when.hint')}
      max={todayIso()}
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
