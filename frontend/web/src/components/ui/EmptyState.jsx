import { useTranslation } from 'react-i18next';
import './EmptyState.css';

export function EmptyState({ title, children }) {
  const { t } = useTranslation();
  return (
    <div className="fa-empty">
      <div className="fa-empty__monkeys" aria-hidden="true">
        {t('common:monkeys.all')}
      </div>
      <h3 className="fa-text-heading">{title}</h3>
      {children && <p className="fa-empty__body fa-text-body fa-text-muted">{children}</p>}
    </div>
  );
}
