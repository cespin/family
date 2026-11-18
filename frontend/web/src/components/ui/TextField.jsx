import { useId } from 'react';
import './TextField.css';

export function TextField({ label, prefix, hint, ...props }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="fa-field">
      <label className="fa-text-label" htmlFor={id}>
        {label}
      </label>
      <div className="fa-field__control">
        {prefix != null && (
          <span className="fa-field__affix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={id}
          className="fa-field__input"
          aria-describedby={hint ? hintId : undefined}
          {...props}
        />
      </div>
      {hint && (
        <p id={hintId} className="fa-text-caption fa-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
