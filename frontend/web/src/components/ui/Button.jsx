import './Button.css';

export function Button({ variant = 'primary', icon: Icon, children, ...props }) {
  return (
    <button type="button" className={`fa-button fa-button--${variant}`} {...props}>
      {Icon && <Icon aria-hidden="true" size={18} />}
      {children}
    </button>
  );
}
