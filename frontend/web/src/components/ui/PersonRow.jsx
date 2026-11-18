import { ChevronRight } from 'lucide-react';
import { Avatar } from './Avatar.jsx';
import './PersonRow.css';

/** One person in a list. With `onClick` the whole row is a button that leads somewhere. */
export function PersonRow({
  person,
  title,
  subtitle,
  trailing,
  avatarSize = 'medium',
  density = 'regular',
  strong = true,
  onClick,
}) {
  const content = (
    <>
      <Avatar name={person.name} tone={person.tone} size={avatarSize} />
      <span className="fa-person-row__main">
        <span className={strong ? 'fa-text-body-strong' : 'fa-text-body'}>{title}</span>
        {subtitle && <span className="fa-text-caption fa-text-muted">{subtitle}</span>}
      </span>
      {trailing}
      {onClick && (
        <span className="fa-person-row__chevron">
          <ChevronRight aria-hidden="true" size={20} strokeWidth={1.75} />
        </span>
      )}
    </>
  );

  return (
    <li className={`fa-person-row fa-person-row--${density}`}>
      {onClick ? (
        <button type="button" className="fa-person-row__button" onClick={onClick}>
          {content}
        </button>
      ) : (
        content
      )}
    </li>
  );
}
