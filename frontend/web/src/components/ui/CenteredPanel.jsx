import './CenteredPanel.css';

/** The single-message layout used by every screen before the dashboard. */
export function CenteredPanel({ icon: Icon, title, body, children }) {
  return (
    <main className="fa-panel">
      <div className="fa-panel__card">
        {Icon && (
          <span className="fa-panel__icon">
            <Icon aria-hidden="true" size={26} />
          </span>
        )}
        <h1 className="fa-panel__title">{title}</h1>
        {body && <p className="fa-panel__body">{body}</p>}
        {children}
      </div>
    </main>
  );
}
