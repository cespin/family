import { ChevronLeft } from 'lucide-react';
import { Button } from '../ui';
import './SubHeader.css';

/** The top of a screen that leads back, with an optional title and action. */
export function SubHeader({ icon = ChevronLeft, backLabel, onBack, title, action }) {
  return (
    <header className="fa-subheader">
      <Button variant="plain" iconOnly icon={icon} aria-label={backLabel} onClick={onBack} />
      {title && <h1 className="fa-subheader__title fa-text-heading">{title}</h1>}
      {action && <div className="fa-subheader__action">{action}</div>}
    </header>
  );
}
