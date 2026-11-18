import { toneFor } from './avatarTone.js';
import './SplitBar.css';

/** How an amount is shared. `parts` is a list of `{ id, name, tone, percent }`. */
export function SplitBar({ label, parts }) {
  return (
    <div className="fa-split-bar" role="img" aria-label={label}>
      {parts.map((part) => (
        <span
          key={part.id}
          className={`fa-split-bar__part fa-split-bar__part--${part.tone ?? toneFor(part.name)}`}
          style={{ flexGrow: part.percent }}
        />
      ))}
    </div>
  );
}
