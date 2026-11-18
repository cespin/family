import { useTranslation } from 'react-i18next';
import { formatMinor } from '../../i18n/format.js';
import './Amount.css';

function toneOf(minor) {
  if (minor > 0) return 'positive';
  return minor < 0 ? 'negative' : 'neutral';
}

/** A signed amount in minor units. A missing amount renders as absent, never as zero. */
export function Amount({ minor, currency, size = 'large', tone = 'auto' }) {
  const { t } = useTranslation();
  if (minor == null) {
    return (
      <span className={`fa-amount fa-amount--${size} fa-amount--muted`}>
        {t('common:status.noData')}
      </span>
    );
  }
  const resolvedTone = tone === 'auto' ? toneOf(minor) : tone;
  return (
    <span className={`fa-amount fa-amount--${size} fa-amount--${resolvedTone}`}>
      {formatMinor(minor, currency)}
    </span>
  );
}
