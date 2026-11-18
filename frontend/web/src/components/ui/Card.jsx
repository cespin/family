import './Card.css';

export function Card({ title, subtitle, flush = false, children }) {
  return (
    <section className={`fa-card${flush ? ' fa-card--flush' : ''}`}>
      {title && (
        <div className="fa-card__head">
          <h2 className="fa-text-heading">{title}</h2>
          {subtitle && <p className="fa-text-caption fa-text-muted">{subtitle}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
