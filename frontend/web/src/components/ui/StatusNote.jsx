import { Check } from 'lucide-react';
import './StatusNote.css';

/** A live message about the form it sits in. `tone` is `success` or `warning`. */
export function StatusNote({ tone = 'success', strong = false, children }) {
  return (
    <div role="status" className={`fa-status fa-status--${tone}`}>
      {tone === 'success' && (
        <span className="fa-status__icon">
          <Check aria-hidden="true" size={20} strokeWidth={1.75} />
        </span>
      )}
      <span className={strong ? 'fa-status__text--strong fa-text-body-strong' : 'fa-text-body'}>
        {children}
      </span>
    </div>
  );
}
