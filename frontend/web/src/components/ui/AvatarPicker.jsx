import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './AvatarPicker.css';

const NEXT = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A grid of emojis to choose one from. It is a single tab stop: arrow keys move the choice, and
 * Home and End jump to the ends, as in any radio group.
 */
export function AvatarPicker({ labelledBy, options, value, onChange }) {
  const { t } = useTranslation();
  const buttons = useRef([]);
  const chosen = options.indexOf(value);
  // With nothing chosen, the first option takes the focus.
  const focusable = chosen === -1 ? 0 : chosen;

  function choose(index) {
    onChange(options[index]);
    buttons.current[index]?.focus();
  }

  function handleKeyDown(event, index) {
    const last = options.length - 1;
    let target;
    if (event.key in NEXT) target = (index + NEXT[event.key] + options.length) % options.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    else return;
    event.preventDefault();
    choose(target);
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="fa-avatar-picker">
      {options.map((emoji, index) => (
        <button
          key={emoji}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={emoji === value}
          aria-label={t('common:avatar.option', { emoji })}
          tabIndex={index === focusable ? 0 : -1}
          className="fa-avatar-picker__option"
          onClick={() => choose(index)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <span aria-hidden="true">{t('common:avatar.emoji', { emoji })}</span>
        </button>
      ))}
    </div>
  );
}
