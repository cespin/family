import { useTranslation } from 'react-i18next';
import { toneFor } from './avatarTone.js';
import { initials } from './initials.js';
import './Avatar.css';

export function Avatar({ name, tone, size = 'medium' }) {
  const { t } = useTranslation();
  return (
    <span
      className={`fa-avatar fa-avatar--${size} fa-avatar--${tone ?? toneFor(name)}`}
      role="img"
      aria-label={name}
      title={name}
    >
      <span aria-hidden="true">
        {t('common:avatar.initials', { initials: initials(name, size === 'small') })}
      </span>
    </span>
  );
}

/** Overlapping avatars. `people` is a list of `{ id, name, tone }`. */
export function AvatarStack({ people, max = 4, size = 'small' }) {
  const { t } = useTranslation();
  const shown = people.length > max ? people.slice(0, max - 1) : people;
  const extra = people.length - shown.length;
  return (
    <span
      className="fa-avatar-stack"
      role="group"
      aria-label={people.map((person) => person.name).join(', ')}
    >
      {shown.map((person) => (
        <Avatar key={person.id} name={person.name} tone={person.tone} size={size} />
      ))}
      {extra > 0 && (
        <span className={`fa-avatar fa-avatar--${size} fa-avatar--more`} aria-hidden="true">
          {t('common:avatar.more', { extra })}
        </span>
      )}
    </span>
  );
}
