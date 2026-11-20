import { toneFor } from './avatarTone.js';
import './SplitBar.css';

/**
 * How an amount is shared. `parts` is a list of `{ id, name, tone, percent }`, and for the options
 * below also `mine` (the reader's part) and `short` (the text under the part).
 * - `size="row"` draws the thinner bar that sits inside a list row.
 * - `emphasis="mine"` fills the reader's part in ink and every other part in a neutral colour,
 *   instead of each person's tone.
 * - `legend` writes each part's `short` under it, in bold for the reader's part.
 */
export function SplitBar({ label, parts, size, emphasis, legend = false }) {
  const className = ['fa-split-bar', size && `fa-split-bar--${size}`, legend && 'fa-split-bar--legend']
    .filter(Boolean)
    .join(' ');
  const fillClass = (part) => {
    const fill = emphasis === 'mine' ? (part.mine ? 'mine' : 'others') : (part.tone ?? toneFor(part.name));
    return `fa-split-bar__part fa-split-bar__part--${fill}`;
  };

  return (
    <div className={className} role="img" aria-label={label}>
      {parts.map((part) =>
        legend ? (
          <span key={part.id} className="fa-split-bar__column" style={{ flexGrow: part.percent }}>
            <span className={fillClass(part)} />
            <span
              className={`fa-split-bar__legend fa-text-caption${part.mine ? ' fa-split-bar__legend--mine' : ''}`}
            >
              {part.short}
            </span>
          </span>
        ) : (
          <span key={part.id} className={fillClass(part)} style={{ flexGrow: part.percent }} />
        ),
      )}
    </div>
  );
}
