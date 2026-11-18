import './Segmented.css';

/** A pill-shaped choice of one. `options` is a list of `{ value, label }`. */
export function Segmented({ labelledBy, options, value, onChange, compact = false }) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className={`fa-segmented${compact ? ' fa-segmented--compact' : ''}`}
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
