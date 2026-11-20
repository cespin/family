import { useId, useState } from 'react';
import './TextField.css';
import './AutocompleteField.css';

/**
 * A text field that offers `suggestions` (distinct strings) under it while it has focus, as an
 * ARIA combobox with a listbox. Picking one calls `onPick` with it; typing still calls `onChange`.
 * Enter picks only an option highlighted with the arrow keys, and otherwise submits the form.
 */
export function AutocompleteField({
  label,
  hint,
  suggestions,
  onPick,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const listId = `${id}-list`;
  const optionId = (index) => `${id}-option-${index}`;

  const [focused, setFocused] = useState(false);
  // Escape or a pick closes the list until the person types again.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);

  const count = suggestions.length;
  const expanded = focused && !dismissed && count > 0;
  const activeIndex = expanded && active < count ? active : -1;

  function close() {
    setDismissed(true);
    setActive(-1);
  }

  function pick(value) {
    onPick(value);
    close();
  }

  function handleChange(event) {
    setDismissed(false);
    setActive(-1);
    onChange?.(event);
  }

  function handleFocus(event) {
    setFocused(true);
    onFocus?.(event);
  }

  function handleBlur(event) {
    setFocused(false);
    setActive(-1);
    onBlur?.(event);
  }

  function handleKeyDown(event) {
    onKeyDown?.(event);
    if (event.defaultPrevented || count === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      setDismissed(false);
      if (!expanded || activeIndex === -1) setActive(down ? 0 : count - 1);
      else setActive((activeIndex + (down ? 1 : count - 1)) % count);
      return;
    }
    if (event.key === 'Enter' && activeIndex !== -1) {
      // The highlighted option is picked instead of submitting the form.
      event.preventDefault();
      pick(suggestions[activeIndex]);
      return;
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
    }
  }

  return (
    <div className="fa-field">
      <label id={labelId} className="fa-text-label" htmlFor={id}>
        {label}
      </label>
      <div className="fa-autocomplete">
        <div className="fa-field__control">
          <input
            id={id}
            className="fa-field__input"
            role="combobox"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={activeIndex !== -1 ? optionId(activeIndex) : undefined}
            aria-describedby={hint ? hintId : undefined}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            {...props}
          />
        </div>
        {expanded && (
          <ul id={listId} className="fa-autocomplete__list" role="listbox" aria-labelledby={labelId}>
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                id={optionId(index)}
                className={
                  index === activeIndex
                    ? 'fa-autocomplete__option fa-autocomplete__option--active'
                    : 'fa-autocomplete__option'
                }
                role="option"
                aria-selected={index === activeIndex}
                // Keeps the focus in the field, so its blur does not close the list before the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(suggestion)}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        )}
      </div>
      {hint && (
        <p id={hintId} className="fa-text-caption fa-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
