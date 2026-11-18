import { Amount } from './Amount.jsx';
import { Avatar } from './Avatar.jsx';
import { MonkeyBadge } from './MonkeyBadge.jsx';
import './ExpenseRow.css';

/** One expense in a list. `netMinor` is null when the reader is not part of the expense. */
export function ExpenseRow({
  payer,
  title,
  meta,
  hiddenLabel,
  netMinor,
  currency,
  amountTone = 'auto',
  label,
  labelTone,
  onClick,
}) {
  return (
    <button type="button" className="fa-expense-row" onClick={onClick}>
      <Avatar name={payer.name} tone={payer.tone} />
      <span className="fa-expense-row__main">
        <span className="fa-expense-row__title fa-text-body-strong">{title}</span>
        <span className="fa-text-caption fa-text-muted">{meta}</span>
        {hiddenLabel && (
          <span className="fa-expense-row__extra">
            <MonkeyBadge kind="hidden">{hiddenLabel}</MonkeyBadge>
          </span>
        )}
      </span>
      <span className="fa-expense-row__share">
        {netMinor != null && (
          <Amount minor={netMinor} currency={currency} size="small" tone={amountTone} />
        )}
        <span className={`fa-text-caption fa-expense-row__label--${labelTone}`}>{label}</span>
      </span>
    </button>
  );
}
