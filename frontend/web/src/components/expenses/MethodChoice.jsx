import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '../ui';
import './MethodChoice.css';

const METHODS = ['transfer', 'cash', 'other'];

/** How money changed hands, for a payment or an advance. `label` is the question above it. */
export function MethodChoice({ label, value, onChange }) {
  const { t } = useTranslation();
  const labelId = useId();
  const methodLabels = {
    transfer: t('expenses:settle.methods.transfer'),
    cash: t('expenses:settle.methods.cash'),
    other: t('expenses:settle.methods.other'),
  };

  return (
    <div className="fa-method-choice">
      <p id={labelId} className="fa-text-label">
        {label}
      </p>
      <div className="fa-method-choice__options" role="group" aria-labelledby={labelId}>
        {METHODS.map((option) => (
          <Chip key={option} pressed={value === option} onClick={() => onChange(option)}>
            {methodLabels[option]}
          </Chip>
        ))}
      </div>
    </div>
  );
}
