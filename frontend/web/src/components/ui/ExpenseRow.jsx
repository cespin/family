import { Amount } from './Amount.jsx';
import { Avatar } from './Avatar.jsx';
import { MonkeyBadge } from './MonkeyBadge.jsx';
import { SplitBar } from './SplitBar.jsx';
import './ExpenseRow.css';

/**
 * One expense in a list. `netMinor` is null when the reader is not part of the expense.
 *
 * `split`, when given, shows how the expense is shared: `{ variant, label, parts, caption }`, with
 * `parts` as `SplitBar` takes them.
 * - `variant: 'mine'` adds a line under the row with the reader's part against everyone else's,
 *   followed by `caption`.
 * - `variant: 'column'` adds a column before the amount with each person's part in their tone and
 *   their initials under it.
 */
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
  split,
  onClick,
}) {
  const variant = split?.variant;
  const avatar = <Avatar name={payer.name} tone={payer.tone} />;
  const main = (
    <span className="fa-expense-row__main">
      <span className="fa-expense-row__title fa-text-body-strong">{title}</span>
      <span className="fa-expense-row__meta fa-text-caption fa-text-muted">{meta}</span>
      {hiddenLabel && (
        <span className="fa-expense-row__extra">
          <MonkeyBadge kind="hidden">{hiddenLabel}</MonkeyBadge>
        </span>
      )}
    </span>
  );
  const share = (
    <span className={`fa-expense-row__share${variant === 'column' ? ' fa-expense-row__share--column' : ''}`}>
      {netMinor != null && <Amount minor={netMinor} currency={currency} size="small" tone={amountTone} />}
      <span className={`fa-text-caption fa-expense-row__label--${labelTone}`}>{label}</span>
    </span>
  );

  if (variant === 'mine') {
    return (
      <button type="button" className="fa-expense-row fa-expense-row--mine" onClick={onClick}>
        <span className="fa-expense-row__line">
          {avatar}
          {main}
          {share}
        </span>
        <span className="fa-expense-row__split">
          <span className="fa-expense-row__bar">
            <SplitBar label={split.label} parts={split.parts} size="row" emphasis="mine" />
          </span>
          <span className="fa-expense-row__caption fa-text-caption">{split.caption}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`fa-expense-row${variant === 'column' ? ' fa-expense-row--column' : ''}`}
      onClick={onClick}
    >
      {avatar}
      {main}
      {variant === 'column' && (
        <span className="fa-expense-row__split-column">
          <SplitBar label={split.label} parts={split.parts} size="row" legend />
        </span>
      )}
      {share}
    </button>
  );
}
