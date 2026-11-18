import './Chip.css';

export function Chip({ pressed = false, children, ...props }) {
  return (
    <button type="button" className="fa-chip" aria-pressed={pressed} {...props}>
      {children}
    </button>
  );
}
