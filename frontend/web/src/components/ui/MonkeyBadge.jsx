import { useTranslation } from 'react-i18next';
import './MonkeyBadge.css';

/** One monkey, one meaning: hidden from someone, or something went wrong. */
export function MonkeyBadge({ kind = 'hidden', children }) {
  const { t } = useTranslation();
  const monkey = kind === 'oops' ? t('common:monkeys.oops') : t('common:monkeys.hidden');
  return (
    <span className={`fa-monkey fa-monkey--${kind} fa-text-caption`}>
      <span className="fa-monkey__emoji" aria-hidden="true">
        {monkey}
      </span>
      <span className="fa-monkey__text">{children}</span>
    </span>
  );
}
