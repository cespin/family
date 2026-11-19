import './Segmented.css';

/**
 * A pill-shaped choice of one. `options` is a list of `{ value, label }`. `wrap` lays them out two
 * to a row, for more options than fit across a phone.
 */
export function Segmented({ labelledBy, options, value, onChange, compact = false, wrap = false }) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className={`fa-segmented${compact ? ' fa-segmented--compact' : ''}${wrap ? ' fa-segmented--wrap' : ''}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="fa-segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
